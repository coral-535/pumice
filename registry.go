package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

type registry struct {
	dir       string
	lockPath  string
	statePath string
	worktree  string
	portNames []string
}

type runtimeState struct {
	Version     int                    `json:"version"`
	Worktree    string                 `json:"worktree"`
	Ports       map[string]string      `json:"ports"`
	Invocations map[string]*invocation `json:"invocations"`
	Services    map[string]*service    `json:"services"`
}

type invocation struct {
	PID       int      `json:"pid"`
	Label     string   `json:"label"`
	StartedAt string   `json:"started_at"`
}

type service struct {
	PID       int               `json:"pid"`
	Command   string            `json:"command"`
	Healthy   bool              `json:"healthy"`
	StartedAt string            `json:"started_at"`
	Refs      map[string]string `json:"refs"`
}

func newRegistry(worktree string, portNames []string) (*registry, error) {
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		base = filepath.Join(os.TempDir(), "pumice-"+strconv.Itoa(os.Getuid()))
	} else {
		base = filepath.Join(base, "pumice")
	}
	sum := sha256.Sum256([]byte(worktree))
	dir := filepath.Join(base, hex.EncodeToString(sum[:12]))
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create runtime directory: %w", err)
	}
	return &registry{
		dir:       dir,
		lockPath:  filepath.Join(dir, "state.lock"),
		statePath: filepath.Join(dir, "state.json"),
		worktree:  worktree,
		portNames: append([]string(nil), portNames...),
	}, nil
}

func (r *registry) withLock(fn func(*runtimeState) error) error {
	lock, err := os.OpenFile(r.lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return fmt.Errorf("open runtime lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return fmt.Errorf("lock runtime state: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck

	state, err := r.readState()
	if err != nil {
		return err
	}
	r.cleanStale(state)
	if err := fn(state); err != nil {
		return err
	}
	return r.writeState(state)
}

func (r *registry) readState() (*runtimeState, error) {
	state := &runtimeState{
		Version:     1,
		Worktree:    r.worktree,
		Ports:       make(map[string]string),
		Invocations: make(map[string]*invocation),
		Services:    make(map[string]*service),
	}
	data, err := os.ReadFile(r.statePath)
	if errors.Is(err, os.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read runtime state: %w", err)
	}
	if err := json.Unmarshal(data, state); err != nil {
		return nil, fmt.Errorf("parse runtime state: %w", err)
	}
	if state.Worktree != r.worktree {
		return nil, errors.New("runtime state belongs to a different worktree")
	}
	if state.Ports == nil {
		state.Ports = make(map[string]string)
	}
	if state.Invocations == nil {
		state.Invocations = make(map[string]*invocation)
	}
	if state.Services == nil {
		state.Services = make(map[string]*service)
	}
	return state, nil
}

func (r *registry) writeState(state *runtimeState) error {
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode runtime state: %w", err)
	}
	tmp, err := os.CreateTemp(r.dir, "state-*.tmp")
	if err != nil {
		return fmt.Errorf("create runtime state: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("write runtime state: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close runtime state: %w", err)
	}
	if err := os.Rename(tmpName, r.statePath); err != nil {
		return fmt.Errorf("replace runtime state: %w", err)
	}
	return nil
}

func (r *registry) cleanStale(state *runtimeState) {
	for id, invocation := range state.Invocations {
		if !processAlive(invocation.PID) {
			delete(state.Invocations, id)
		}
	}
	for name, svc := range state.Services {
		if !processAlive(svc.PID) {
			delete(state.Services, name)
			continue
		}
		if svc.Refs == nil {
			svc.Refs = make(map[string]string)
		}
		for id := range svc.Refs {
			if _, ok := state.Invocations[id]; !ok {
				delete(svc.Refs, id)
			}
		}
		if len(svc.Refs) == 0 {
			stopProcess(svc.PID)
			delete(state.Services, name)
		}
	}
	if len(state.Services) == 0 && len(state.Invocations) == 0 {
		state.Ports = make(map[string]string)
	}
}

func (r *registry) ensurePorts(state *runtimeState) error {
	for _, name := range r.portNames {
		if state.Ports[name] != "" {
			continue
		}
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return fmt.Errorf("allocate port for %s: %w", name, err)
		}
		state.Ports[name] = strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
		if err := listener.Close(); err != nil {
			return fmt.Errorf("release allocated port for %s: %w", name, err)
		}
	}
	return nil
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func stopProcess(pid int) {
	if pid <= 0 {
		return
	}
	// Commands run in their own process group, so descendants receive the signal too.
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	deadline := time.Now().Add(3 * time.Second)
	for processAlive(pid) && time.Now().Before(deadline) {
		time.Sleep(25 * time.Millisecond)
	}
	if processAlive(pid) {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}
