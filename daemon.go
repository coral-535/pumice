package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"
)

// A small grace period absorbs adjacent CLI invocations without leaving an
// unused background process around. The daemon cannot exit while a connection
// or managed service is still registered.
const daemonIdleTimeout = 250 * time.Millisecond

type daemonServer struct {
	root       string
	mu         sync.Mutex
	manager    *serviceManager
	digest     string
	conns      map[net.Conn]bool
	lastActive time.Time
}

func runDaemon(args []string) int {
	if len(args) != 1 {
		fmt.Fprintln(os.Stderr, "pum: invalid internal daemon invocation")
		return 2
	}
	root, err := filepath.Abs(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "pum daemon: resolve worktree: %v\n", err)
		return 1
	}
	paths, err := newRuntimePaths(root)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pum daemon: %v\n", err)
		return 1
	}

	lifetimeLock, err := os.OpenFile(paths.daemonLock, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pum daemon: open daemon lock: %v\n", err)
		return 1
	}
	defer lifetimeLock.Close()
	if err := syscall.Flock(int(lifetimeLock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		fmt.Fprintln(os.Stderr, "pum daemon: another daemon already owns this worktree")
		return 1
	}

	if err := os.Remove(paths.socket); err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(os.Stderr, "pum daemon: remove stale socket: %v\n", err)
		return 1
	}
	listener, err := net.Listen("unix", paths.socket)
	if err != nil {
		fmt.Fprintf(os.Stderr, "pum daemon: listen: %v\n", err)
		return 1
	}
	defer listener.Close()
	defer os.Remove(paths.socket)
	if err := os.Chmod(paths.socket, 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "pum daemon: secure socket: %v\n", err)
		return 1
	}
	if err := os.WriteFile(paths.pid, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o600); err != nil {
		fmt.Fprintf(os.Stderr, "pum daemon: write pid: %v\n", err)
		return 1
	}
	defer os.Remove(paths.pid)

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := &daemonServer{
		root:       root,
		conns:      make(map[net.Conn]bool),
		lastActive: time.Now(),
	}

	unixListener := listener.(*net.UnixListener)
	go func() {
		<-ctx.Done()
		_ = unixListener.Close()
	}()
	for {
		if err := unixListener.SetDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
			fmt.Fprintf(os.Stderr, "pum daemon: set accept deadline: %v\n", err)
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
				fmt.Fprintf(os.Stderr, "pum daemon: accept: %v\n", err)
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
	s.conns[conn] = true
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
	if len(s.conns) != 0 || time.Since(s.lastActive) < daemonIdleTimeout {
		return false
	}
	return s.manager == nil || s.manager.idle()
}

func (s *daemonServer) configure(cfg *projectConfig, digest string) (*serviceManager, error) {
	if cfg == nil {
		return nil, errors.New("client did not provide project configuration")
	}
	if filepath.Clean(cfg.Root) != s.root {
		return nil, errors.New("client configuration belongs to a different worktree")
	}
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("invalid client configuration: %w", err)
	}
	if configDigest(cfg) != digest {
		return nil, errors.New("client configuration digest does not match its contents")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.manager != nil && s.digest == digest {
		return s.manager, nil
	}
	if s.manager != nil && (len(s.conns) > 1 || !s.manager.idle()) {
		return nil, errors.New("pumice.yaml changed while services are active; stop active commands and retry")
	}
	if s.manager != nil {
		s.manager.shutdown()
	}
	manager, err := newServiceManager(cfg)
	if err != nil {
		return nil, err
	}
	s.manager = manager
	s.digest = digest
	return manager, nil
}

func (s *daemonServer) serveConn(parent context.Context, conn net.Conn) {
	defer func() {
		conn.Close()
		s.removeConn(conn)
	}()

	decoder := json.NewDecoder(conn)
	var request clientMessage
	if err := decoder.Decode(&request); err != nil {
		return
	}
	writer := &eventWriter{encoder: json.NewEncoder(conn)}
	if request.Version != protocolVersion {
		writer.done(fmt.Errorf(
			"daemon protocol %d is incompatible with client protocol %d; wait for active commands to finish and retry",
			protocolVersion,
			request.Version,
		))
		return
	}
	if request.Type != "run" {
		writer.done(fmt.Errorf("unsupported daemon request %q", request.Type))
		return
	}
	manager, err := s.configure(request.Config, request.Digest)
	if err != nil {
		writer.done(err)
		return
	}

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		writer.done(fmt.Errorf("create command input pipe: %w", err))
		return
	}
	defer stdinRead.Close()
	relay := newStdinRelay(stdinWrite, cancel)
	defer relay.close()
	go relay.run()

	go func() {
		for {
			var message clientMessage
			if err := decoder.Decode(&message); err != nil {
				relay.close()
				cancel()
				return
			}
			switch message.Type {
			case "input":
				if err := relay.enqueue(message.Data); err != nil {
					cancel()
					return
				}
			case "input_eof":
				relay.close()
			case "cancel":
				relay.close()
				cancel()
				return
			}
		}
	}()

	err = manager.run(
		ctx,
		request.Name,
		stdinRead,
		writer.stream("stdout"),
		writer.stream("stderr"),
	)
	writer.done(err)
}

const maxPendingStdin = 4 << 20

type stdinRelay struct {
	mu           sync.Mutex
	writer       *os.File
	pending      [][]byte
	pendingBytes int
	closed       bool
	wake         chan struct{}
	cancel       context.CancelFunc
	closeOnce    sync.Once
}

func newStdinRelay(writer *os.File, cancel context.CancelFunc) *stdinRelay {
	return &stdinRelay{
		writer: writer,
		wake:   make(chan struct{}, 1),
		cancel: cancel,
	}
}

func (r *stdinRelay) enqueue(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return io.ErrClosedPipe
	}
	if r.pendingBytes+len(data) > maxPendingStdin {
		return errors.New("command input exceeded the daemon buffer while the command was not reading")
	}
	r.pending = append(r.pending, append([]byte(nil), data...))
	r.pendingBytes += len(data)
	select {
	case r.wake <- struct{}{}:
	default:
	}
	return nil
}

func (r *stdinRelay) close() {
	r.closeOnce.Do(func() {
		r.mu.Lock()
		r.closed = true
		r.mu.Unlock()
		select {
		case r.wake <- struct{}{}:
		default:
		}
	})
}

func (r *stdinRelay) run() {
	defer r.writer.Close()
	for {
		r.mu.Lock()
		if len(r.pending) != 0 {
			data := r.pending[0]
			r.pending = r.pending[1:]
			r.pendingBytes -= len(data)
			r.mu.Unlock()
			if _, err := r.writer.Write(data); err != nil {
				r.cancel()
				return
			}
			continue
		}
		closed := r.closed
		r.mu.Unlock()
		if closed {
			return
		}
		<-r.wake
	}
}

func (s *daemonServer) shutdown() {
	s.mu.Lock()
	manager := s.manager
	conns := make([]net.Conn, 0, len(s.conns))
	for conn := range s.conns {
		conns = append(conns, conn)
	}
	s.mu.Unlock()

	if manager != nil {
		manager.shutdown()
	}
	for _, conn := range conns {
		_ = conn.Close()
	}
}

type eventWriter struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

type daemonStreamWriter struct {
	parent *eventWriter
	stream string
}

func (w *eventWriter) stream(name string) io.Writer {
	return &daemonStreamWriter{parent: w, stream: name}
}

func (w *daemonStreamWriter) Write(data []byte) (int, error) {
	w.parent.mu.Lock()
	defer w.parent.mu.Unlock()
	copyOfData := append([]byte(nil), data...)
	err := w.parent.encoder.Encode(&daemonEvent{
		Type:   "output",
		Stream: w.stream,
		Data:   copyOfData,
	})
	if err != nil {
		return 0, err
	}
	return len(data), nil
}

func (w *eventWriter) done(err error) {
	event := daemonEvent{Type: "done"}
	if err != nil {
		event.Error = err.Error()
		event.ExitCode = 1
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	_ = w.encoder.Encode(&event)
}
