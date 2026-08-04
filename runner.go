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
	"sync"
	"time"
)

const healthInterval = 200 * time.Millisecond

type serviceManager struct {
	ctx    context.Context
	cancel context.CancelFunc
	root   string

	mu             sync.Mutex
	portNames      []string
	ports          map[string]string
	services       map[string]*daemonService
	nextGeneration uint64
	nextLease      uint64
}

type daemonService struct {
	name        string
	generation  uint64
	configHash  string
	definition  serviceDefinition
	process     *managedCommand
	leases      map[uint64]struct{}
	ready       chan struct{}
	failed      chan struct{}
	stopped     chan struct{}
	readyOnce   sync.Once
	failedOnce  sync.Once
	stoppedOnce sync.Once
	healthy     bool
	stopping    bool
	failure     error
}

type serviceLease struct {
	id      uint64
	service *daemonService
}

func newServiceManager(root string) *serviceManager {
	ctx, cancel := context.WithCancel(context.Background())
	return &serviceManager{
		ctx:      ctx,
		cancel:   cancel,
		root:     root,
		services: make(map[string]*daemonService),
	}
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

func (m *serviceManager) acquire(
	ctx context.Context,
	definition *serviceDefinition,
	configHash string,
) (*serviceLease, map[string]string, error) {
	for {
		m.mu.Lock()
		if m.ports == nil {
			ports, err := allocatePorts(definition.Ports)
			if err != nil {
				m.mu.Unlock()
				return nil, nil, err
			}
			m.portNames = append([]string(nil), definition.Ports...)
			m.ports = ports
		} else if !equalStrings(m.portNames, definition.Ports) {
			m.mu.Unlock()
			return nil, nil, fmt.Errorf(
				"service %q declares a different port set from the active worktree daemon",
				definition.Name,
			)
		}

		if existing := m.services[definition.Name]; existing != nil {
			if existing.stopping {
				stopped := existing.stopped
				m.mu.Unlock()
				select {
				case <-stopped:
					continue
				case <-ctx.Done():
					return nil, nil, ctx.Err()
				}
			}
			if existing.configHash != configHash {
				m.mu.Unlock()
				return nil, nil, fmt.Errorf(
					"service %q is already acquired with a different definition",
					definition.Name,
				)
			}
			m.nextLease++
			lease := &serviceLease{id: m.nextLease, service: existing}
			existing.leases[lease.id] = struct{}{}
			environment := cloneEnvironment(m.ports)
			m.mu.Unlock()
			if err := m.awaitReady(ctx, existing); err != nil {
				m.release(lease)
				return nil, nil, err
			}
			return lease, environment, nil
		}

		m.nextGeneration++
		m.nextLease++
		svc := &daemonService{
			name:       definition.Name,
			generation: m.nextGeneration,
			configHash: configHash,
			definition: *definition,
			leases:     map[uint64]struct{}{m.nextLease: {}},
			ready:      make(chan struct{}),
			failed:     make(chan struct{}),
			stopped:    make(chan struct{}),
		}
		lease := &serviceLease{id: m.nextLease, service: svc}
		m.services[svc.name] = svc
		environment := cloneEnvironment(m.ports)
		m.mu.Unlock()

		go m.initializeService(svc)
		if err := m.awaitReady(ctx, svc); err != nil {
			m.release(lease)
			return nil, nil, err
		}
		return lease, environment, nil
	}
}

func (m *serviceManager) initializeService(svc *daemonService) {
	process, err := startManagedCommand(
		m.root,
		svc.definition.Command,
		m.commandEnv(),
		nil,
		os.Stdout,
		os.Stderr,
	)
	if err != nil {
		m.failStart(svc, fmt.Errorf("start service %q: %w", svc.name, err))
		return
	}

	m.mu.Lock()
	if m.services[svc.name] != svc || svc.stopping {
		m.mu.Unlock()
		process.stop(false)
		<-process.done
		m.finishService(svc)
		return
	}
	svc.process = process
	m.mu.Unlock()

	go func() {
		err := <-process.done
		m.serviceExited(svc, err)
	}()

	ctx, cancel := context.WithTimeout(m.ctx, svc.definition.timeout())
	defer cancel()
	ticker := time.NewTicker(healthInterval)
	defer ticker.Stop()

	for {
		m.mu.Lock()
		active := m.services[svc.name] == svc && !svc.stopping && svc.failure == nil
		m.mu.Unlock()
		if !active {
			return
		}

		if err := m.runHealthcheck(ctx, svc.definition.Healthcheck); err == nil {
			m.mu.Lock()
			if m.services[svc.name] == svc && !svc.stopping && svc.failure == nil {
				svc.healthy = true
				svc.readyOnce.Do(func() { close(svc.ready) })
				m.mu.Unlock()
				return
			}
			m.mu.Unlock()
			return
		}

		select {
		case <-ctx.Done():
			failure := ctx.Err()
			if errors.Is(failure, context.DeadlineExceeded) {
				failure = fmt.Errorf(
					"service %q generation %d did not become ready within %s",
					svc.name,
					svc.generation,
					svc.definition.timeout(),
				)
			}
			m.failStart(svc, failure)
			return
		case <-ticker.C:
		}
	}
}

func (m *serviceManager) runHealthcheck(ctx context.Context, command string) error {
	process, err := startManagedCommand(
		m.root,
		command,
		m.commandEnv(),
		nil,
		io.Discard,
		io.Discard,
	)
	if err != nil {
		return err
	}
	select {
	case err := <-process.done:
		return err
	case <-ctx.Done():
		process.stop(true)
		<-process.done
		return ctx.Err()
	}
}

func (m *serviceManager) awaitReady(ctx context.Context, svc *daemonService) error {
	select {
	case <-svc.ready:
		m.mu.Lock()
		failure := svc.failure
		healthy := svc.healthy
		m.mu.Unlock()
		if failure != nil {
			return failure
		}
		if !healthy {
			return fmt.Errorf("service %q generation %d stopped before readiness", svc.name, svc.generation)
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *serviceManager) failStart(svc *daemonService, failure error) {
	m.mu.Lock()
	if svc.failure == nil {
		svc.failure = failure
	}
	svc.stopping = true
	process := svc.process
	svc.readyOnce.Do(func() { close(svc.ready) })
	svc.failedOnce.Do(func() { close(svc.failed) })
	m.mu.Unlock()
	if process != nil {
		process.stop(false)
		<-process.done
	}
	m.finishService(svc)
}

func (m *serviceManager) serviceExited(svc *daemonService, processErr error) {
	m.mu.Lock()
	if m.services[svc.name] != svc {
		m.mu.Unlock()
		return
	}
	if !svc.stopping {
		svc.stopping = true
		failure := fmt.Errorf("service %q generation %d exited unexpectedly", svc.name, svc.generation)
		if processErr != nil {
			failure = fmt.Errorf("%w: %v", failure, processErr)
		}
		svc.failure = failure
		svc.readyOnce.Do(func() { close(svc.ready) })
		svc.failedOnce.Do(func() { close(svc.failed) })
	}
	m.mu.Unlock()
	m.finishService(svc)
}

func (m *serviceManager) release(lease *serviceLease) {
	if lease == nil || lease.service == nil {
		return
	}
	svc := lease.service
	m.mu.Lock()
	delete(svc.leases, lease.id)
	if len(svc.leases) != 0 || svc.stopping || m.services[svc.name] != svc {
		m.mu.Unlock()
		return
	}
	svc.stopping = true
	process := svc.process
	svc.readyOnce.Do(func() { close(svc.ready) })
	m.mu.Unlock()
	if process == nil {
		// initializeService observes stopping immediately after the process is
		// created and performs the cleanup. Do not close the slot early or the
		// late-created process could escape its guard.
		return
	}
	process.stop(false)
	<-process.done
	m.finishService(svc)
}

func (m *serviceManager) failure(svc *daemonService) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return svc.failure
}

func (m *serviceManager) finishService(svc *daemonService) {
	m.mu.Lock()
	if m.services[svc.name] == svc {
		delete(m.services, svc.name)
	}
	svc.stoppedOnce.Do(func() { close(svc.stopped) })
	m.mu.Unlock()
}

func (m *serviceManager) idle() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.services) == 0
}

func (m *serviceManager) commandEnv() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	names := make([]string, 0, len(m.ports))
	for name := range m.ports {
		names = append(names, name)
	}
	sort.Strings(names)
	environment := make([]string, 0, len(names))
	for _, name := range names {
		environment = append(environment, name+"="+m.ports[name])
	}
	return environment
}

func (m *serviceManager) shutdown() {
	m.cancel()
	m.mu.Lock()
	services := make([]*daemonService, 0, len(m.services))
	for _, svc := range m.services {
		if !svc.stopping {
			svc.stopping = true
			svc.readyOnce.Do(func() { close(svc.ready) })
		}
		services = append(services, svc)
	}
	m.mu.Unlock()
	for _, svc := range services {
		if svc.process != nil {
			svc.process.stop(false)
			<-svc.process.done
			m.finishService(svc)
		}
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func cloneEnvironment(environment map[string]string) map[string]string {
	clone := make(map[string]string, len(environment))
	for name, value := range environment {
		clone[name] = value
	}
	return clone
}
