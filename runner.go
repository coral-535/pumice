package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	healthTimeout  = 30 * time.Second
	healthInterval = 200 * time.Millisecond
)

type runner struct {
	cfg        *projectConfig
	registry   *registry
	stdout     io.Writer
	stderr     io.Writer
	id         string
	label      string
	ports      map[string]string
	completed  map[string]bool
	processes  map[string]*managedProcess
	releaseOnce sync.Once
}

type managedProcess struct {
	pid    int
	done   chan error
}

func newRunner(cfg *projectConfig, stdout, stderr io.Writer) (*runner, error) {
	reg, err := newRegistry(cfg.Root, cfg.Ports)
	if err != nil {
		return nil, err
	}
	return &runner{
		cfg:       cfg,
		registry:  reg,
		stdout:    stdout,
		stderr:    stderr,
		id:        fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()),
		completed: make(map[string]bool),
		processes: make(map[string]*managedProcess),
	}, nil
}

func (r *runner) Run(ctx context.Context, name string) (runErr error) {
	target, ok := r.cfg.Tasks[name]
	if !ok {
		return fmt.Errorf("unknown task %q", name)
	}
	r.label = name
	if err := r.begin(); err != nil {
		return err
	}
	defer func() {
		if err := r.release(); runErr == nil && err != nil {
			runErr = err
		}
	}()

	if target.isService() {
		for _, dependency := range target.DependsOn {
			if err := r.execute(ctx, dependency); err != nil {
				return err
			}
		}
		process, err := r.ensureService(ctx, name, true)
		if err != nil {
			return err
		}
		select {
		case err := <-process.done:
			if err != nil && ctx.Err() == nil {
				return fmt.Errorf("service %q exited: %w", name, err)
			}
			return ctx.Err()
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return r.execute(ctx, name)
}

func (r *runner) begin() error {
	return r.registry.withLock(func(state *runtimeState) error {
		if err := r.registry.ensurePorts(state); err != nil {
			return err
		}
		state.Invocations[r.id] = &invocation{
			PID:       os.Getpid(),
			Label:     r.label,
			StartedAt: time.Now().UTC().Format(time.RFC3339Nano),
		}
		r.ports = cloneMap(state.Ports)
		return nil
	})
}

func (r *runner) execute(ctx context.Context, name string) error {
	if r.completed[name] {
		return nil
	}
	task := r.cfg.Tasks[name]
	for _, dependency := range task.DependsOn {
		if err := r.execute(ctx, dependency); err != nil {
			return err
		}
	}
	if task.isService() {
		if _, err := r.ensureService(ctx, name, false); err != nil {
			return err
		}
		r.completed[name] = true
		return nil
	}

	fmt.Fprintf(r.stderr, "Running %s...\n", name)
	cmd := r.shellCommand(ctx, task.Command)
	cmd.Stdout = r.stdout
	cmd.Stderr = r.stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", name, err)
	}
	fmt.Fprintf(r.stderr, "%s completed.\n", name)
	r.completed[name] = true
	return nil
}

func (r *runner) ensureService(ctx context.Context, name string, direct bool) (*managedProcess, error) {
	task := r.cfg.Tasks[name]
	var process *managedProcess
	var existing, healthy bool

	err := r.registry.withLock(func(state *runtimeState) error {
		svc, ok := state.Services[name]
		if ok {
			if direct {
				return fmt.Errorf(
					"service %q is already running in this worktree\nAttaching to an existing service is not supported",
					name,
				)
			}
			svc.Refs[r.id] = r.label
			existing = true
			healthy = svc.Healthy
			return nil
		}

		fmt.Fprintf(r.stderr, "Starting %s...\n", name)
		cmd := r.shellCommand(context.Background(), task.Command)
		cmd.Stdout = r.stdout
		cmd.Stderr = r.stderr
		cmd.Stdin = nil
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("start service %q: %w", name, err)
		}
		process = &managedProcess{pid: cmd.Process.Pid, done: make(chan error, 1)}
		r.processes[name] = process
		state.Services[name] = &service{
			PID:       process.pid,
			Command:   task.Command,
			StartedAt: time.Now().UTC().Format(time.RFC3339Nano),
			Refs:      map[string]string{r.id: r.label},
		}
		go func() {
			err := cmd.Wait()
			process.done <- err
			close(process.done)
			r.markExited(name, process.pid)
		}()
		return nil
	})
	if err != nil {
		return nil, err
	}
	if existing {
		fmt.Fprintf(r.stderr, "Using existing %s service.\n", name)
		if healthy {
			return &managedProcess{pid: r.servicePID(name), done: make(chan error)}, nil
		}
	} else if direct {
		// A direct service is always newly started, so its process can be waited on.
	} else if process == nil {
		return nil, fmt.Errorf("service %q has no managed process", name)
	}

	if !healthy {
		fmt.Fprintf(r.stderr, "Waiting for %s to become healthy...\n", name)
		if err := r.waitHealthy(ctx, name, task.Healthcheck); err != nil {
			return nil, err
		}
		fmt.Fprintf(r.stderr, "%s is healthy.\n", name)
	}
	if process == nil {
		process = &managedProcess{pid: r.servicePID(name), done: make(chan error)}
	}
	return process, nil
}

func (r *runner) waitHealthy(ctx context.Context, name, healthcheck string) error {
	ctx, cancel := context.WithTimeout(ctx, healthTimeout)
	defer cancel()
	ticker := time.NewTicker(healthInterval)
	defer ticker.Stop()

	for {
		if !r.serviceAlive(name) {
			return fmt.Errorf("service %q exited before becoming healthy", name)
		}
		cmd := r.shellCommand(ctx, healthcheck)
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard
		if err := cmd.Run(); err == nil {
			return r.registry.withLock(func(state *runtimeState) error {
				svc, ok := state.Services[name]
				if !ok {
					return fmt.Errorf("service %q exited before becoming healthy", name)
				}
				svc.Healthy = true
				return nil
			})
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return fmt.Errorf("service %q did not become healthy within %s", name, healthTimeout)
			}
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (r *runner) shellCommand(ctx context.Context, command string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = r.cfg.Root
	cmd.Env = os.Environ()
	names := make([]string, 0, len(r.ports))
	for name := range r.ports {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		cmd.Env = append(cmd.Env, name+"="+r.ports[name])
	}
	return cmd
}

func (r *runner) serviceAlive(name string) bool {
	alive := false
	_ = r.registry.withLock(func(state *runtimeState) error {
		svc, ok := state.Services[name]
		alive = ok && processAlive(svc.PID)
		return nil
	})
	return alive
}

func (r *runner) servicePID(name string) int {
	pid := 0
	_ = r.registry.withLock(func(state *runtimeState) error {
		if svc := state.Services[name]; svc != nil {
			pid = svc.PID
		}
		return nil
	})
	return pid
}

func (r *runner) markExited(name string, pid int) {
	_ = r.registry.withLock(func(state *runtimeState) error {
		if svc := state.Services[name]; svc != nil && svc.PID == pid {
			delete(state.Services, name)
		}
		return nil
	})
}

func (r *runner) release() error {
	var releaseErr error
	r.releaseOnce.Do(func() {
		releaseErr = r.registry.withLock(func(state *runtimeState) error {
			delete(state.Invocations, r.id)
			for name, svc := range state.Services {
				delete(svc.Refs, r.id)
				if len(svc.Refs) != 0 {
					owners := uniqueOwners(svc.Refs)
					fmt.Fprintf(r.stderr, "%s remains active because it is still required by %s.\n",
						name, strings.Join(owners, ", "))
					continue
				}
				fmt.Fprintf(r.stderr, "Stopping %s because it is no longer required.\n", name)
				stopProcess(svc.PID)
				delete(state.Services, name)
			}
			if len(state.Services) == 0 && len(state.Invocations) == 0 {
				state.Ports = make(map[string]string)
			}
			return nil
		})
	})
	return releaseErr
}

func uniqueOwners(refs map[string]string) []string {
	set := make(map[string]bool)
	for _, owner := range refs {
		set[owner] = true
	}
	owners := make([]string, 0, len(set))
	for owner := range set {
		owners = append(owners, owner)
	}
	sort.Strings(owners)
	return owners
}

func cloneMap(source map[string]string) map[string]string {
	clone := make(map[string]string, len(source))
	for key, value := range source {
		clone[key] = value
	}
	return clone
}

func (p *managedProcess) String() string {
	return strconv.Itoa(p.pid)
}
