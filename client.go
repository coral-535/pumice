package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

const readyLinePrefix = "PUMICE_READY "

type readyMessage struct {
	Type        string            `json:"type"`
	Service     string            `json:"service"`
	Generation  uint64            `json:"generation"`
	Environment map[string]string `json:"environment"`
}

// runLeaseClient acquires exactly one generation and intentionally remains
// connected until its context is cancelled or that generation fails. The
// socket lifetime is the lease lifetime.
func runLeaseClient(
	ctx context.Context,
	root string,
	definition *serviceDefinition,
	readiness io.Writer,
) error {
	conn, err := connectDaemon(root)
	if err != nil {
		return err
	}
	defer conn.Close()

	request := clientMessage{
		Version:    protocolVersion,
		Type:       "acquire",
		Definition: definition,
		ConfigHash: definitionDigest(definition),
	}
	if err := json.NewEncoder(conn).Encode(&request); err != nil {
		return fmt.Errorf("send acquisition request: %w", err)
	}

	finished := make(chan struct{})
	defer close(finished)
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-finished:
		}
	}()

	decoder := json.NewDecoder(conn)
	ready := false
	for {
		var event daemonEvent
		if err := decoder.Decode(&event); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, io.EOF) || isClosedConnection(err) {
				return errors.New("worktree daemon stopped unexpectedly; the service generation was terminated")
			}
			return fmt.Errorf("read daemon event: %w", err)
		}
		switch event.Type {
		case "ready":
			if ready {
				return errors.New("worktree daemon reported readiness more than once")
			}
			ready = true
			message := readyMessage{
				Type:        "ready",
				Service:     definition.Name,
				Generation:  event.Generation,
				Environment: event.Environment,
			}
			data, _ := json.Marshal(&message)
			if _, err := fmt.Fprintf(readiness, "%s%s\n", readyLinePrefix, data); err != nil {
				return fmt.Errorf("report service readiness: %w", err)
			}
		case "failed":
			if event.Error == "" {
				event.Error = fmt.Sprintf("service %q generation %d failed", definition.Name, event.Generation)
			}
			return errors.New(event.Error)
		case "error":
			if event.Error == "" {
				event.Error = "worktree daemon rejected the service acquisition"
			}
			return errors.New(event.Error)
		default:
			return fmt.Errorf("worktree daemon sent unknown event %q", event.Type)
		}
	}
}

func connectDaemon(root string) (net.Conn, error) {
	paths, err := newRuntimePaths(root)
	if err != nil {
		return nil, err
	}
	if conn, err := net.DialTimeout("unix", paths.socket, 100*time.Millisecond); err == nil {
		return conn, nil
	}

	lock, err := os.OpenFile(paths.startLock, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open daemon startup lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return nil, fmt.Errorf("lock daemon startup: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck

	if conn, err := net.DialTimeout("unix", paths.socket, 100*time.Millisecond); err == nil {
		return conn, nil
	}
	if err := startDaemonProcess(root, paths.log); err != nil {
		return nil, err
	}

	deadline := time.Now().Add(5 * time.Second)
	var lastErr error
	for time.Now().Before(deadline) {
		conn, dialErr := net.DialTimeout("unix", paths.socket, 100*time.Millisecond)
		if dialErr == nil {
			return conn, nil
		}
		lastErr = dialErr
		time.Sleep(25 * time.Millisecond)
	}
	logTail := readDaemonLog(paths.log)
	if logTail != "" {
		return nil, fmt.Errorf("daemon did not start: %v\n%s", lastErr, logTail)
	}
	return nil, fmt.Errorf("daemon did not start: %w", lastErr)
}

func startDaemonProcess(root, logPath string) error {
	executable, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate pumice executable: %w", err)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}
	cmd := exec.Command(executable, "_daemon", root)
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		_ = logFile.Close()
		return fmt.Errorf("start worktree daemon: %w", err)
	}
	_ = logFile.Close()
	if err := cmd.Process.Release(); err != nil {
		return fmt.Errorf("detach worktree daemon: %w", err)
	}
	return nil
}

func readDaemonLog(filename string) string {
	data, err := os.ReadFile(filename)
	if err != nil {
		return ""
	}
	const limit = 4096
	if len(data) > limit {
		data = data[len(data)-limit:]
	}
	return strings.TrimSpace(string(data))
}

func isClosedConnection(err error) bool {
	return strings.Contains(err.Error(), "use of closed network connection") ||
		strings.Contains(err.Error(), "connection reset by peer")
}
