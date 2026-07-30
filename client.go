package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

func runDaemonClient(
	ctx context.Context,
	cfg *projectConfig,
	name string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) error {
	conn, err := connectDaemon(cfg)
	if err != nil {
		return err
	}
	defer conn.Close()
	finished := make(chan struct{})
	defer close(finished)

	sender := &clientSender{encoder: json.NewEncoder(conn)}
	if err := sender.send(clientMessage{
		Version: protocolVersion,
		Type:    "run",
		Name:    name,
		Digest:  configDigest(cfg),
		Config:  cfg,
	}); err != nil {
		return fmt.Errorf("send daemon request: %w", err)
	}

	go func() {
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := stdin.Read(buffer)
			if n > 0 {
				if err := sender.send(clientMessage{Type: "input", Data: buffer[:n]}); err != nil {
					return
				}
			}
			if readErr != nil {
				_ = sender.send(clientMessage{Type: "input_eof"})
				return
			}
		}
	}()
	go func() {
		select {
		case <-ctx.Done():
			_ = sender.send(clientMessage{Type: "cancel"})
		case <-finished:
		}
	}()

	decoder := json.NewDecoder(conn)
	for {
		var event daemonEvent
		if err := decoder.Decode(&event); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, io.EOF) || isClosedConnection(err) {
				return errors.New("worktree daemon stopped unexpectedly; all managed processes were terminated")
			}
			return fmt.Errorf("read daemon response: %w", err)
		}
		switch event.Type {
		case "output":
			target := stdout
			if event.Stream == "stderr" {
				target = stderr
			}
			if _, err := target.Write(event.Data); err != nil {
				return err
			}
		case "done":
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if event.Error != "" {
				return errors.New(event.Error)
			}
			return nil
		}
	}
}

type clientSender struct {
	mu      sync.Mutex
	encoder *json.Encoder
}

func (s *clientSender) send(message clientMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.encoder.Encode(&message)
}

func connectDaemon(cfg *projectConfig) (net.Conn, error) {
	paths, err := newRuntimePaths(cfg.Root)
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
	if err := startDaemonProcess(cfg.Root, paths.log); err != nil {
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
		return fmt.Errorf("locate pum executable: %w", err)
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fmt.Errorf("open daemon log: %w", err)
	}
	cmd := exec.Command(executable, "_daemon", root)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("start worktree daemon: %w", err)
	}
	_ = logFile.Close()
	if err := cmd.Process.Release(); err != nil {
		return fmt.Errorf("detach worktree daemon: %w", err)
	}
	return nil
}

func configDigest(cfg *projectConfig) string {
	data, _ := json.Marshal(cfg)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
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
