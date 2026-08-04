package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "_daemon":
			os.Exit(runDaemon(os.Args[2:]))
		case "_exec":
			os.Exit(runExecSupervisor(os.Args[2:]))
		}
	}
	os.Exit(m.Run())
}

func TestServiceLeaseLifecycleAndPortDelivery(t *testing.T) {
	root := t.TempDir()
	ready := root + "/ready"
	portFile := root + "/port"
	definition := testServiceDefinition(ready, root+"/pid")
	definition.Ports = []string{"DATABASE_PORT"}
	definition.Command = fmt.Sprintf(
		"echo \"$DATABASE_PORT\" > %s; touch %s; trap 'rm -f %s; exit 0' TERM INT; while :; do sleep 1; done",
		shellQuote(portFile), shellQuote(ready), shellQuote(ready),
	)

	manager := newServiceManager(root)
	t.Cleanup(manager.shutdown)
	lease, environment, err := manager.acquire(context.Background(), definition, definitionDigest(definition))
	if err != nil {
		t.Fatal(err)
	}
	if lease.service.generation != 1 {
		t.Fatalf("generation = %d, want 1", lease.service.generation)
	}
	port := environment["DATABASE_PORT"]
	if value, err := strconv.Atoi(port); err != nil || value <= 0 {
		t.Fatalf("DATABASE_PORT = %q, want a positive integer", port)
	}
	if got := strings.TrimSpace(readTestFile(t, portFile)); got != port {
		t.Fatalf("service port = %q, ready environment port = %q", got, port)
	}

	manager.release(lease)
	waitFor(t, 5*time.Second, func() bool { return !pathExists(ready) && manager.idle() })
}

func TestConcurrentAcquisitionsReuseExactGeneration(t *testing.T) {
	root := t.TempDir()
	ready := root + "/ready"
	starts := root + "/starts"
	definition := testServiceDefinition(ready, root+"/pid")
	definition.Command = fmt.Sprintf(
		"echo start >> %s; touch %s; trap 'rm -f %s; exit 0' TERM INT; while :; do sleep 1; done",
		shellQuote(starts), shellQuote(ready), shellQuote(ready),
	)
	manager := newServiceManager(root)
	t.Cleanup(manager.shutdown)

	type result struct {
		lease *serviceLease
		err   error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			lease, _, err := manager.acquire(context.Background(), definition, definitionDigest(definition))
			results <- result{lease: lease, err: err}
		}()
	}
	firstResult := <-results
	secondResult := <-results
	if firstResult.err != nil {
		t.Fatal(firstResult.err)
	}
	if secondResult.err != nil {
		t.Fatal(secondResult.err)
	}
	first, second := firstResult.lease, secondResult.lease
	if first.service != second.service || first.service.generation != second.service.generation {
		t.Fatal("concurrent leases did not share the exact service generation")
	}
	if startsCount := len(strings.Fields(readTestFile(t, starts))); startsCount != 1 {
		t.Fatalf("service started %d times, want once", startsCount)
	}

	manager.release(first)
	if !pathExists(ready) {
		t.Fatal("releasing one of two leases stopped the shared service")
	}
	manager.release(second)
	waitFor(t, 5*time.Second, func() bool { return !pathExists(ready) && manager.idle() })
}

func TestLaterAcquisitionCreatesNewGeneration(t *testing.T) {
	root := t.TempDir()
	definition := testServiceDefinition(root+"/ready", root+"/pid")
	manager := newServiceManager(root)
	t.Cleanup(manager.shutdown)

	first, _, err := manager.acquire(context.Background(), definition, definitionDigest(definition))
	if err != nil {
		t.Fatal(err)
	}
	manager.release(first)
	waitFor(t, 5*time.Second, manager.idle)

	second, _, err := manager.acquire(context.Background(), definition, definitionDigest(definition))
	if err != nil {
		t.Fatal(err)
	}
	if first.service.generation != 1 || second.service.generation != 2 {
		t.Fatalf("generation sequence = %d, %d; want 1, 2", first.service.generation, second.service.generation)
	}
	manager.release(second)
}

func TestActiveServiceRejectsDifferentDefinition(t *testing.T) {
	root := t.TempDir()
	definition := testServiceDefinition(root+"/ready", root+"/pid")
	manager := newServiceManager(root)
	t.Cleanup(manager.shutdown)
	lease, _, err := manager.acquire(context.Background(), definition, definitionDigest(definition))
	if err != nil {
		t.Fatal(err)
	}

	changed := *definition
	changed.Command += " --changed"
	_, _, err = manager.acquire(context.Background(), &changed, definitionDigest(&changed))
	if err == nil || !strings.Contains(err.Error(), "different definition") {
		t.Fatalf("conflicting acquisition error = %v", err)
	}
	manager.release(lease)
}

func TestUnexpectedServiceExitFailsExactGeneration(t *testing.T) {
	root := t.TempDir()
	ready := root + "/ready"
	definition := &serviceDefinition{
		Name:        "db",
		Command:     "touch " + shellQuote(ready) + "; sleep 0.35",
		Healthcheck: "test -f " + shellQuote(ready),
	}
	manager := newServiceManager(root)
	t.Cleanup(manager.shutdown)
	lease, _, err := manager.acquire(context.Background(), definition, definitionDigest(definition))
	if err != nil {
		t.Fatal(err)
	}

	select {
	case <-lease.service.failed:
		failure := manager.failure(lease.service)
		if failure == nil || !strings.Contains(failure.Error(), "generation 1 exited unexpectedly") {
			t.Fatalf("failure = %v", failure)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("service exit was not reported")
	}
	manager.release(lease)
}

func TestDaemonLeaseReportsReadinessAndDisconnectStopsService(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	definition := testServiceDefinition(ready, root+"/pid")
	ctx, cancel := context.WithCancel(context.Background())
	var output safeBuffer
	done := make(chan error, 1)
	go func() { done <- runLeaseClient(ctx, root, definition, &output) }()

	waitFor(t, 5*time.Second, func() bool {
		return pathExists(ready) && strings.Contains(output.String(), readyLinePrefix)
	})
	line := strings.TrimSpace(strings.TrimPrefix(output.String(), readyLinePrefix))
	var message readyMessage
	if err := json.Unmarshal([]byte(line), &message); err != nil {
		t.Fatalf("parse readiness line %q: %v", line, err)
	}
	if message.Service != "db" || message.Generation != 1 {
		t.Fatalf("readiness = %#v", message)
	}

	cancel()
	if err := waitResult(t, done); err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("lease cancellation error = %v", err)
	}
	waitFor(t, 5*time.Second, func() bool { return !pathExists(ready) })
	stopTestDaemon(root)
}

func TestDaemonDeathKillsGuardedService(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	pidFile := root + "/pid"
	definition := testServiceDefinition(ready, pidFile)
	var output safeBuffer
	done := make(chan error, 1)
	go func() { done <- runLeaseClient(context.Background(), root, definition, &output) }()
	waitFor(t, 5*time.Second, func() bool { return pathExists(ready) })
	servicePID := readPID(t, pidFile)
	paths, err := newRuntimePaths(root)
	if err != nil {
		t.Fatal(err)
	}
	daemonPID := readPID(t, paths.pid)
	if err := syscall.Kill(daemonPID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	if err := waitResult(t, done); err == nil || !strings.Contains(err.Error(), "daemon stopped unexpectedly") {
		t.Fatalf("lease error = %v", err)
	}
	waitFor(t, 5*time.Second, func() bool { return !testProcessAlive(servicePID) })
}

func testServiceDefinition(ready, pidFile string) *serviceDefinition {
	return &serviceDefinition{
		Name: "db",
		Command: fmt.Sprintf(
			"echo $$ > %s; touch %s; trap 'rm -f %s; exit 0' TERM INT; while :; do sleep 1; done",
			shellQuote(pidFile), shellQuote(ready), shellQuote(ready),
		),
		Healthcheck: "test -f " + shellQuote(ready),
	}
}

func useIsolatedRuntime(t *testing.T) {
	t.Helper()
	dir, err := os.MkdirTemp("/tmp", "pumice-test-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	t.Setenv("XDG_RUNTIME_DIR", dir)
}

func stopTestDaemon(root string) {
	paths, err := newRuntimePaths(root)
	if err != nil {
		return
	}
	data, err := os.ReadFile(paths.pid)
	if err != nil {
		return
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err == nil && pid > 0 {
		_ = syscall.Kill(pid, syscall.SIGTERM)
	}
}

func readPID(t *testing.T, filename string) int {
	t.Helper()
	pid, err := strconv.Atoi(strings.TrimSpace(readTestFile(t, filename)))
	if err != nil {
		t.Fatalf("parse pid in %s: %v", filename, err)
	}
	return pid
}

func testProcessAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func pathExists(filename string) bool {
	_, err := os.Stat(filename)
	return err == nil
}

func waitResult(t *testing.T, result <-chan error) error {
	t.Helper()
	select {
	case err := <-result:
		return err
	case <-time.After(8 * time.Second):
		t.Fatal("operation did not finish before timeout")
		return nil
	}
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func readTestFile(t *testing.T, filename string) string {
	t.Helper()
	data, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

type safeBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (b *safeBuffer) Write(data []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.Write(data)
}

func (b *safeBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buffer.String()
}

var _ io.Writer = (*safeBuffer)(nil)
