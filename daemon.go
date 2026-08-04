package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

const daemonIdleTimeout = 250 * time.Millisecond

type daemonServer struct {
	manager    *serviceManager
	mu         sync.Mutex
	conns      map[net.Conn]struct{}
	lastActive time.Time
}

func runDaemon(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "pumice daemon: invalid internal invocation")
		return 2
	}
	root, err := filepath.Abs(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "pumice daemon: resolve worktree: %v\n", err)
		return 1
	}
	paths, err := newRuntimePaths(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pumice daemon: %v\n", err)
		return 1
	}

	lifetimeLock, err := os.OpenFile(paths.daemonLock, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pumice daemon: open lifetime lock: %v\n", err)
		return 1
	}
	defer lifetimeLock.Close()
	if err := syscall.Flock(int(lifetimeLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		fmt.Fprintln(os.Stderr, "pumice daemon: another daemon already owns this worktree")
		return 1
	}

	if err := os.Remove(paths.socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "pumice daemon: remove stale socket: %v\n", err)
		return 1
	}
	listener, err := net.Listen("unix", paths.socket)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pumice daemon: listen: %v\n", err)
		return 1
	}
	defer listener.Close()
	defer os.Remove(paths.socket)
	if err := os.Chmod(paths.socket, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "pumice daemon: secure socket: %v\n", err)
		return 1
	}
	if err := os.WriteFile(paths.pid, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "pumice daemon: write pid: %v\n", err)
		return 1
	}
	defer os.Remove(paths.pid)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &daemonServer{
		manager:    newServiceManager(root),
		conns:      make(map[net.Conn]struct{}),
		lastActive: time.Now(),
	}

	unixListener := listener.(*net.UnixListener)
	go func() {
		<-ctx.Done()
		_ = unixListener.Close()
	}()
	for {
		if err := unixListener.SetDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
			fmt.Fprintf(os.Stderr, "pumice daemon: set accept deadline: %v\n", err)
			server.shutdown()
			return 1
		}
		conn, err := unixListener.Accept()
		if err == nil {
			server.addConn(conn)
			go server.serveConn(ctx, conn)
			continue
		}
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() {
			if ctx.Err() == nil {
				fmt.Fprintf(os.Stderr, "pumice daemon: accept: %v\n", err)
			}
			server.shutdown()
			if ctx.Err() != nil {
				return 0
			}
			return 1
		}
		if ctx.Err() != nil || server.shouldExitIdle() {
			server.shutdown()
			return 0
		}
	}
}

func (s *daemonServer) addConn(conn net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.conns[conn] = struct{}{}
	s.lastActive = time.Now()
}

func (s *daemonServer) removeConn(conn net.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.conns, conn)
	s.lastActive = time.Now()
}

func (s *daemonServer) shouldExitIdle() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.conns) == 0 &&
		time.Since(s.lastActive) >= daemonIdleTimeout &&
		s.manager.idle()
}

func (s *daemonServer) serveConn(parent context.Context, conn net.Conn) {
	defer func() {
		_ = conn.Close()
		s.removeConn(conn)
	}()

	decoder := json.NewDecoder(conn)
	writer := &eventWriter{encoder: json.NewEncoder(conn)}
	var request clientMessage
	if err := decoder.Decode(&request); err != nil {
		return
	}
	if request.Version != protocolVersion {
		writer.send(daemonEvent{Type: "error", Error: fmt.Sprintf(
			"daemon protocol %d is incompatible with client protocol %d; wait for active leases to finish and retry",
			protocolVersion,
			request.Version,
		)})
		return
	}
	if request.Type != "acquire" {
		writer.send(daemonEvent{Type: "error", Error: fmt.Sprintf("unsupported daemon request %q", request.Type)})
		return
	}
	if request.Definition == nil {
		writer.send(daemonEvent{Type: "error", Error: "acquisition request has no service definition"})
		return
	}
	request.Definition.canonicalize()
	if err := request.Definition.validate(); err != nil {
		writer.send(daemonEvent{Type: "error", Error: err.Error()})
		return
	}
	if definitionDigest(request.Definition) != request.ConfigHash {
		writer.send(daemonEvent{Type: "error", Error: "service definition hash does not match its contents"})
		return
	}

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	go func() {
		var message clientMessage
		for {
			if err := decoder.Decode(&message); err != nil {
				cancel()
				return
			}
			if message.Type == "release" || message.Type == "cancel" {
				cancel()
				return
			}
		}
	}()

	lease, environment, err := s.manager.acquire(ctx, request.Definition, request.ConfigHash)
	if err != nil {
		if ctx.Err() == nil {
			writer.send(daemonEvent{Type: "error", Error: err.Error()})
		}
		return
	}
	defer s.manager.release(lease)

	writer.send(daemonEvent{
		Type:        "ready",
		Generation:  lease.service.generation,
		Environment: environment,
	})

	select {
	case <-ctx.Done():
		return
	case <-lease.service.failed:
		failure := s.manager.failure(lease.service)
		if failure == nil {
			failure = fmt.Errorf(
				"service %q generation %d failed",
				lease.service.name,
				lease.service.generation,
			)
		}
		writer.send(daemonEvent{
			Type:       "failed",
			Generation: lease.service.generation,
			Error:      failure.Error(),
		})
	}
}

func (s *daemonServer) shutdown() {
	s.manager.shutdown()
	s.mu.Lock()
	connections := make([]net.Conn, 0, len(s.conns))
	for conn := range s.conns {
		connections = append(connections, conn)
	}
	s.mu.Unlock()
	for _, conn := range connections {
		_ = conn.Close()
	}
}

type eventWriter struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func (w *eventWriter) send(event daemonEvent) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.encoder.Encode(&event)
}
