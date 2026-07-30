package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// runner preserves the package-level execution API while routing all work
// through the daemon. Keeping this small adapter also makes embedders and older
// package tests receive the same ownership guarantees as the CLI.
type runner struct {
	cfg    *projectConfig
	stdout io.Writer
	stderr io.Writer
}

func newRunner(cfg *projectConfig, stdout, stderr io.Writer) (*runner, error) {
	if _, err := newRuntimePaths(cfg.Root); err != nil {
		return nil, err
	}
	return &runner{cfg: cfg, stdout: stdout, stderr: stderr}, nil
}

func (r *runner) Run(ctx context.Context, name string) error {
	return runDaemonClient(ctx, r.cfg, name, os.Stdin, r.stdout, r.stderr)
}

func (r *runner) serviceStopOrder() []string {
	manager := &serviceManager{cfg: r.cfg}
	return manager.serviceStopOrder()
}

const (
	healthTimeout  = 30 * time.Second
	healthInterval = 200 * time.Millisecond
)

type serviceManager struct {
	ctx         context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	cfg         *projectConfig
	ports       map[string]string
	services    map[string]*daemonService
	invocations map[string]*daemonInvocation
	nextID      uint64
}

type daemonService struct {
	name      string
	process   *managedCommand
	refs      map[string]string
	ready     chan struct{}
	readyOnce sync.Once
	stopped   chan struct{}
	cleanup   sync.Once
	healthy   bool
	startErr  error
	stopping  bool
}

type daemonInvocation struct {
	id       string
	label    string
	ctx      context.Context
	cancel   context.CancelFunc
	stderr   io.Writer
	acquired map[string]bool
	failure  error
}

func newServiceManager(cfg *projectConfig) (*serviceManager, error) {
	ports, err := allocatePorts(cfg.Ports)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &serviceManager{
		ctx:         ctx,
		cancel:      cancel,
		cfg:         cfg,
		ports:       ports,
		services:    make(map[string]*daemonService),
		invocations: make(map[string]*daemonInvocation),
	}, nil
}

func allocatePorts(names []string) (map[string]string, error) {
	ports := make(map[string]string, len(names))
	for _, name := range names {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return nil, fmt.Errorf("allocate port for %s: %w", name, err)
		}
		ports[name] = strconv.Itoa(listener.Addr().(*net.TCPAddr).Port)
		if err := listener.Close(); err != nil {
			return nil, fmt.Errorf("release allocated port for %s: %w", name, err)
		}
	}
	return ports, nil
}

func (m *serviceManager) idle() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.invocations) == 0 && len(m.services) == 0
}

func (m *serviceManager) run(
	parent context.Context,
	name string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) (runErr error) {
	target, ok := m.cfg.Tasks[name]
	if !ok {
		return fmt.Errorf("unknown task %q", name)
	}

	inv := m.beginInvocation(parent, name, stderr)
	defer func() {
		m.releaseInvocation(inv)
		if failure := m.invocationFailure(inv); failure != nil {
			runErr = failure
		}
	}()

	completed := make(map[string]bool)
	if target.isService() {
		for _, dependency := range target.DependsOn {
			if err := m.execute(inv, dependency, stdin, stdout, stderr, completed); err != nil {
				return err
			}
		}
		if _, err := m.ensureService(inv, name, true, stdout, stderr); err != nil {
			return err
		}
		<-inv.ctx.Done()
		if failure := m.invocationFailure(inv); failure != nil {
			return failure
		}
		return inv.ctx.Err()
	}
	return m.execute(inv, name, stdin, stdout, stderr, completed)
}

func (m *serviceManager) beginInvocation(
	parent context.Context,
	label string,
	stderr io.Writer,
) *daemonInvocation {
	ctx, cancel := context.WithCancel(parent)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.nextID++
	inv := &daemonInvocation{
		id:       fmt.Sprintf("%d", m.nextID),
		label:    label,
		ctx:      ctx,
		cancel:   cancel,
		stderr:   stderr,
		acquired: make(map[string]bool),
	}
	m.invocations[inv.id] = inv
	return inv
}

func (m *serviceManager) execute(
	inv *daemonInvocation,
	name string,
	stdin io.Reader,
	stdout, stderr io.Writer,
	completed map[string]bool,
) error {
	if completed[name] {
		return nil
	}
	task := m.cfg.Tasks[name]
	for _, dependency := range task.DependsOn {
		if err := m.execute(inv, dependency, stdin, stdout, stderr, completed); err != nil {
			return err
		}
	}
	if task.isService() {
		if _, err := m.ensureService(inv, name, false, stdout, stderr); err != nil {
			return err
		}
		completed[name] = true
		return nil
	}

	fmt.Fprintf(stderr, "Running %s...\n", name)
	err := m.runCommand(inv.ctx, task.Command, stdin, stdout, stderr)
	if err != nil {
		if failure := m.invocationFailure(inv); failure != nil {
			return failure
		}
		return fmt.Errorf("%s failed: %w", name, err)
	}
	fmt.Fprintf(stderr, "%s completed.\n", name)
	completed[name] = true
	return nil
}

func (m *serviceManager) ensureService(
	inv *daemonInvocation,
	name string,
	direct bool,
	stdout, stderr io.Writer,
) (*daemonService, error) {
	m.mu.Lock()
	if inv.acquired[name] {
		svc := m.services[name]
		m.mu.Unlock()
		if svc == nil {
			return nil, fmt.Errorf("service %q is no longer running", name)
		}
		return svc, m.awaitService(inv, svc)
	}
	if existing := m.services[name]; existing != nil {
		if existing.stopping {
			stopped := existing.stopped
			m.mu.Unlock()
			select {
			case <-stopped:
				return m.ensureService(inv, name, direct, stdout, stderr)
			case <-inv.ctx.Done():
				if failure := m.invocationFailure(inv); failure != nil {
					return nil, failure
				}
				return nil, inv.ctx.Err()
			}
		}
		if direct {
			m.mu.Unlock()
			return nil, fmt.Errorf(
				"Service %q is already running in this worktree.\nAttaching to an existing service is not supported.",
				name,
			)
		}
		existing.refs[inv.id] = inv.label
		inv.acquired[name] = true
		healthy := existing.healthy
		m.mu.Unlock()
		fmt.Fprintf(stderr, "Using existing %s service.\n", name)
		if healthy {
			return existing, nil
		}
		return existing, m.awaitService(inv, existing)
	}

	svc := &daemonService{
		name:    name,
		refs:    map[string]string{inv.id: inv.label},
		ready:   make(chan struct{}),
		stopped: make(chan struct{}),
	}
	m.services[name] = svc
	inv.acquired[name] = true
	m.mu.Unlock()

	fmt.Fprintf(stderr, "Starting %s...\n", name)
	serviceStdout, serviceStderr := io.Discard, io.Discard
	if direct {
		serviceStdout, serviceStderr = stdout, stderr
	}
	go m.initializeService(svc, m.cfg.Tasks[name], serviceStdout, serviceStderr, stderr)
	return svc, m.awaitService(inv, svc)
}

func (m *serviceManager) initializeService(
	svc *daemonService,
	task *entry,
	stdout, stderr, lifecycle io.Writer,
) {
	process, err := startManagedCommand(m.cfg.Root, task.Command, m.commandEnv(), nil, stdout, stderr)
	if err != nil {
		m.failServiceStart(svc, fmt.Errorf("start service %q: %w", svc.name, err))
		return
	}

	m.mu.Lock()
	if svc.stopping || m.services[svc.name] != svc {
		m.mu.Unlock()
		m.completeServiceStop(svc, process)
		return
	}
	svc.process = process
	m.mu.Unlock()

	go func() {
		err := <-process.done
		m.serviceExited(svc, err)
	}()

	fmt.Fprintf(lifecycle, "Waiting for %s to become healthy...\n", svc.name)
	ctx, cancel := context.WithTimeout(m.ctx, healthTimeout)
	defer cancel()
	ticker := time.NewTicker(healthInterval)
	defer ticker.Stop()

	for {
		m.mu.Lock()
		active := m.services[svc.name] == svc && !svc.stopping && svc.startErr == nil
		m.mu.Unlock()
		if !active {
			return
		}

		if err := m.runCommand(ctx, task.Healthcheck, nil, io.Discard, io.Discard); err == nil {
			m.mu.Lock()
			if m.services[svc.name] == svc && !svc.stopping && svc.startErr == nil {
				svc.healthy = true
				svc.readyOnce.Do(func() { close(svc.ready) })
				m.mu.Unlock()
				fmt.Fprintf(lifecycle, "%s is healthy.\n", svc.name)
				return
			}
			m.mu.Unlock()
			return
		}

		select {
		case <-ctx.Done():
			var startErr error
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				startErr = fmt.Errorf("service %q did not become healthy within %s", svc.name, healthTimeout)
			} else {
				startErr = ctx.Err()
			}
			m.failServiceStart(svc, startErr)
			return
		case <-ticker.C:
		}
	}
}

func (m *serviceManager) awaitService(inv *daemonInvocation, svc *daemonService) error {
	select {
	case <-svc.ready:
		m.mu.Lock()
		err := svc.startErr
		healthy := svc.healthy
		m.mu.Unlock()
		if err != nil {
			return err
		}
		if !healthy {
			return fmt.Errorf("service %q exited before becoming healthy", svc.name)
		}
		return nil
	case <-inv.ctx.Done():
		if failure := m.invocationFailure(inv); failure != nil {
			return failure
		}
		return inv.ctx.Err()
	}
}

func (m *serviceManager) failServiceStart(svc *daemonService, err error) {
	var process *managedCommand
	var cancels []context.CancelFunc
	m.mu.Lock()
	if svc.startErr == nil {
		svc.startErr = err
	}
	svc.readyOnce.Do(func() { close(svc.ready) })
	svc.stopping = true
	process = svc.process
	for id := range svc.refs {
		if inv := m.invocations[id]; inv != nil {
			if inv.failure == nil {
				inv.failure = err
			}
			cancels = append(cancels, inv.cancel)
		}
	}
	m.mu.Unlock()
	m.completeServiceStop(svc, process)
	for _, cancel := range cancels {
		cancel()
	}
}

func (m *serviceManager) serviceExited(svc *daemonService, processErr error) {
	var stops []*daemonService
	var cancels []context.CancelFunc

	m.mu.Lock()
	if svc.stopping {
		svc.readyOnce.Do(func() { close(svc.ready) })
		m.mu.Unlock()
		return
	}
	if m.services[svc.name] != svc {
		m.mu.Unlock()
		return
	}

	failure := fmt.Errorf("service %q exited unexpectedly", svc.name)
	if processErr != nil {
		failure = fmt.Errorf("service %q exited unexpectedly: %w", svc.name, processErr)
	}
	svc.startErr = failure
	svc.readyOnce.Do(func() { close(svc.ready) })

	affected := map[string]bool{svc.name: true}
	for changed := true; changed; {
		changed = false
		for name := range m.services {
			if affected[name] {
				continue
			}
			for _, dependency := range m.cfg.Tasks[name].DependsOn {
				if affected[dependency] {
					affected[name] = true
					changed = true
					break
				}
			}
		}
	}

	cancelSet := make(map[string]bool)
	for name := range affected {
		candidate := m.services[name]
		if candidate == nil {
			continue
		}
		candidate.stopping = true
		if candidate.startErr == nil {
			candidate.startErr = fmt.Errorf(
				"service %q stopped because dependency %q exited",
				name, svc.name,
			)
		}
		candidate.readyOnce.Do(func() { close(candidate.ready) })
		if candidate != svc && candidate.process != nil {
			stops = append(stops, candidate)
		}
		for id := range candidate.refs {
			cancelSet[id] = true
		}
	}
	for id := range cancelSet {
		if inv := m.invocations[id]; inv != nil {
			if inv.failure == nil {
				inv.failure = failure
			}
			cancels = append(cancels, inv.cancel)
		}
	}
	m.mu.Unlock()

	m.completeServiceStop(svc, nil)
	for _, candidate := range stops {
		m.completeServiceStop(candidate, candidate.process)
	}
	for _, cancel := range cancels {
		cancel()
	}
}

func (m *serviceManager) runCommand(
	ctx context.Context,
	command string,
	stdin io.Reader,
	stdout, stderr io.Writer,
) error {
	process, err := startManagedCommand(m.cfg.Root, command, m.commandEnv(), stdin, stdout, stderr)
	if err != nil {
		return err
	}
	select {
	case err := <-process.done:
		return err
	case <-ctx.Done():
		process.stop(false)
		<-process.done
		return ctx.Err()
	}
}

func (m *serviceManager) commandEnv() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.ports))
	for name := range m.ports {
		names = append(names, name)
	}
	sort.Strings(names)
	env := make([]string, 0, len(names))
	for _, name := range names {
		env = append(env, name+"="+m.ports[name])
	}
	return env
}

func (m *serviceManager) invocationFailure(inv *daemonInvocation) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return inv.failure
}

func (m *serviceManager) releaseInvocation(inv *daemonInvocation) {
	inv.cancel()
	var stops []*daemonService

	m.mu.Lock()
	delete(m.invocations, inv.id)
	for name := range inv.acquired {
		if svc := m.services[name]; svc != nil {
			delete(svc.refs, inv.id)
		}
	}

	for _, name := range m.serviceStopOrder() {
		svc := m.services[name]
		if svc == nil {
			continue
		}
		if svc.stopping {
			continue
		}
		if len(svc.refs) != 0 {
			owners := uniqueOwners(svc.refs)
			fmt.Fprintf(inv.stderr, "%s remains active because it is still required by %s.\n",
				name, strings.Join(owners, ", "))
			continue
		}
		fmt.Fprintf(inv.stderr, "Stopping %s because it is no longer required.\n", name)
		svc.stopping = true
		svc.readyOnce.Do(func() { close(svc.ready) })
		stops = append(stops, svc)
	}
	m.mu.Unlock()

	for _, svc := range stops {
		if svc.process != nil {
			m.completeServiceStop(svc, svc.process)
		}
	}
}

func (m *serviceManager) completeServiceStop(svc *daemonService, process *managedCommand) {
	svc.cleanup.Do(func() {
		if process != nil {
			process.stop(false)
			<-process.done
		}
		m.mu.Lock()
		if m.services[svc.name] == svc {
			delete(m.services, svc.name)
		}
		close(svc.stopped)
		m.mu.Unlock()
	})
}

func (m *serviceManager) serviceStopOrder() []string {
	seen := make(map[string]bool)
	var order []string
	var visit func(string)
	visit = func(name string) {
		if seen[name] {
			return
		}
		seen[name] = true
		task := m.cfg.Tasks[name]
		if task == nil {
			return
		}
		for _, dependency := range task.DependsOn {
			visit(dependency)
		}
		if task.isService() {
			order = append(order, name)
		}
	}
	names := make([]string, 0, len(m.cfg.Tasks))
	for name := range m.cfg.Tasks {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		visit(name)
	}
	for left, right := 0, len(order)-1; left < right; left, right = left+1, right-1 {
		order[left], order[right] = order[right], order[left]
	}
	return order
}

func (m *serviceManager) shutdown() {
	m.cancel()
	var services []*daemonService
	var cancels []context.CancelFunc
	m.mu.Lock()
	for _, inv := range m.invocations {
		cancels = append(cancels, inv.cancel)
	}
	for _, svc := range m.services {
		svc.stopping = true
		if svc.process != nil {
			services = append(services, svc)
		}
	}
	m.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	for _, svc := range services {
		m.completeServiceStop(svc, svc.process)
	}
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
