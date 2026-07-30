package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
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

func TestTemporaryServiceLifecycleAndPortInjection(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	servicePort := root + "/service-port"
	taskPort := root + "/task-port"
	cfg := testConfig(root, ready, servicePort, taskPort)

	var output safeBuffer
	err := runDaemonClient(
		context.Background(),
		cfg,
		"migrate",
		strings.NewReader(""),
		&output,
		&output,
	)
	if err != nil {
		t.Fatalf("runDaemonClient() error = %v\noutput:\n%s", err, output.String())
	}
	t.Cleanup(func() { stopTestDaemon(cfg.Root) })

	serviceValue := strings.TrimSpace(readTestFile(t, servicePort))
	taskValue := strings.TrimSpace(readTestFile(t, taskPort))
	if serviceValue != taskValue {
		t.Fatalf("service port %q != task port %q", serviceValue, taskValue)
	}
	if port, err := strconv.Atoi(serviceValue); err != nil || port <= 0 {
		t.Fatalf("managed port = %q, want a positive integer", serviceValue)
	}
	waitFor(t, 3*time.Second, func() bool { return !pathExists(ready) })

	log := output.String()
	for _, message := range []string{
		"Starting db...",
		"Waiting for db to become healthy...",
		"db is healthy.",
		"Running migrate...",
		"migrate completed.",
		"Stopping db because it is no longer required.",
	} {
		if !strings.Contains(log, message) {
			t.Errorf("output does not contain %q:\n%s", message, log)
		}
	}
}

func TestDaemonSerializesConcurrentServiceStartup(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	starts := root + "/starts"
	gate := root + "/gate"
	cfg := &projectConfig{
		Root: root,
		Tasks: map[string]*entry{
			"db": {
				Lifecycle: "service",
				Command: fmt.Sprintf(
					"trap 'rm -f %s; exit 0' TERM INT; echo start >> %s; touch %s; while :; do sleep 1; done",
					shellQuote(ready), shellQuote(starts), shellQuote(ready),
				),
				Healthcheck: "test -f " + shellQuote(ready),
			},
			"one": {
				Command:   "while [ ! -f " + shellQuote(gate) + " ]; do sleep 0.05; done",
				DependsOn: []string{"db"},
			},
			"two": {
				Command:   "while [ ! -f " + shellQuote(gate) + " ]; do sleep 0.05; done",
				DependsOn: []string{"db"},
			},
		},
	}
	t.Cleanup(func() { stopTestDaemon(cfg.Root) })

	var firstOutput, secondOutput safeBuffer
	firstDone := make(chan error, 1)
	secondDone := make(chan error, 1)
	go func() {
		firstDone <- runDaemonClient(context.Background(), cfg, "one", strings.NewReader(""), &firstOutput, &firstOutput)
	}()
	go func() {
		secondDone <- runDaemonClient(context.Background(), cfg, "two", strings.NewReader(""), &secondOutput, &secondOutput)
	}()

	waitFor(t, 5*time.Second, func() bool {
		return pathExists(ready) &&
			strings.Contains(firstOutput.String(), "Running one...") &&
			strings.Contains(secondOutput.String(), "Running two...")
	})
	writeTestFile(t, gate, "go")
	if err := waitResult(t, firstDone); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := waitResult(t, secondDone); err != nil {
		t.Fatalf("second run: %v", err)
	}

	lines := strings.Fields(readTestFile(t, starts))
	if len(lines) != 1 {
		t.Fatalf("service was started %d times, want exactly once", len(lines))
	}
	combined := firstOutput.String() + secondOutput.String()
	if !strings.Contains(combined, "Using existing db service.") {
		t.Fatalf("concurrent request did not reuse daemon-locked service:\n%s", combined)
	}
}

func TestServiceNameRemainsLockedWhileStopping(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	active := root + "/active"
	overlap := root + "/overlap"
	cfg := &projectConfig{
		Root: root,
		Tasks: map[string]*entry{
			"db": {
				Lifecycle: "service",
				Command: fmt.Sprintf(
					"if [ -f %s ]; then touch %s; fi; touch %s %s; trap 'sleep 0.5; rm -f %s %s; exit 0' TERM INT; while :; do sleep 1; done",
					shellQuote(active), shellQuote(overlap), shellQuote(active), shellQuote(ready),
					shellQuote(active), shellQuote(ready),
				),
				Healthcheck: "test -f " + shellQuote(ready),
			},
			"use": {Command: "true", DependsOn: []string{"db"}},
		},
	}
	t.Cleanup(func() { stopTestDaemon(cfg.Root) })

	var firstOutput, secondOutput safeBuffer
	firstDone := make(chan error, 1)
	secondDone := make(chan error, 1)
	go func() {
		firstDone <- runDaemonClient(context.Background(), cfg, "use", strings.NewReader(""), &firstOutput, &firstOutput)
	}()
	waitFor(t, 5*time.Second, func() bool {
		return strings.Contains(firstOutput.String(), "Stopping db because it is no longer required.")
	})
	go func() {
		secondDone <- runDaemonClient(context.Background(), cfg, "use", strings.NewReader(""), &secondOutput, &secondOutput)
	}()

	if err := waitResult(t, firstDone); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if err := waitResult(t, secondDone); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if pathExists(overlap) {
		t.Fatal("a replacement service started before the stopping service released its daemon lock")
	}
}

func TestClientDisconnectImmediatelyReleasesAndStopsService(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	pidFile := root + "/service.pid"
	cfg := directServiceConfig(root, "db", ready, pidFile, nil)
	t.Cleanup(func() { stopTestDaemon(cfg.Root) })

	conn, err := connectDaemon(cfg)
	if err != nil {
		t.Fatal(err)
	}
	sender := &clientSender{encoder: json.NewEncoder(conn)}
	if err := sender.send(clientMessage{
		Version: protocolVersion,
		Type:    "run",
		Name:    "db",
		Digest:  configDigest(cfg),
		Config:  cfg,
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool { return pathExists(ready) })
	servicePID := readPID(t, pidFile)

	if err := conn.Close(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 5*time.Second, func() bool {
		return !pathExists(ready) && !testProcessAlive(servicePID)
	})
}

func TestDependencyExitStopsDependentServiceAndClient(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	dbReady := root + "/db.ready"
	dbPIDFile := root + "/db.pid"
	devReady := root + "/dev.ready"
	devPIDFile := root + "/dev.pid"
	cfg := directServiceConfig(root, "db", dbReady, dbPIDFile, nil)
	cfg.Tasks["dev"] = serviceEntry(devReady, devPIDFile, []string{"db"})
	t.Cleanup(func() { stopTestDaemon(cfg.Root) })

	var output safeBuffer
	done := make(chan error, 1)
	go func() {
		done <- runDaemonClient(
			context.Background(),
			cfg,
			"dev",
			strings.NewReader(""),
			&output,
			&output,
		)
	}()
	waitFor(t, 5*time.Second, func() bool { return pathExists(dbReady) && pathExists(devReady) })
	dbPID := readPID(t, dbPIDFile)
	devPID := readPID(t, devPIDFile)

	if err := syscall.Kill(dbPID, syscall.SIGKILL); err != nil {
		t.Fatalf("kill dependency: %v", err)
	}
	err := waitResult(t, done)
	if err == nil || !strings.Contains(err.Error(), `service "db" exited unexpectedly`) {
		t.Fatalf("client error = %v\noutput:\n%s", err, output.String())
	}
	waitFor(t, 5*time.Second, func() bool {
		return !testProcessAlive(devPID) && !pathExists(devReady)
	})
}

func TestDaemonDeathKillsManagedServiceAndDisconnectsClient(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	pidFile := root + "/service.pid"
	cfg := directServiceConfig(root, "db", ready, pidFile, nil)

	var output safeBuffer
	done := make(chan error, 1)
	go func() {
		done <- runDaemonClient(
			context.Background(),
			cfg,
			"db",
			strings.NewReader(""),
			&output,
			&output,
		)
	}()
	waitFor(t, 5*time.Second, func() bool { return pathExists(ready) })
	servicePID := readPID(t, pidFile)
	paths, err := newRuntimePaths(cfg.Root)
	if err != nil {
		t.Fatal(err)
	}
	daemonPID := readPID(t, paths.pid)

	if err := syscall.Kill(daemonPID, syscall.SIGKILL); err != nil {
		t.Fatalf("kill daemon: %v", err)
	}
	err = waitResult(t, done)
	if err == nil || !strings.Contains(err.Error(), "daemon stopped unexpectedly") {
		t.Fatalf("client error = %v", err)
	}
	waitFor(t, 5*time.Second, func() bool {
		return !testProcessAlive(servicePID)
	})
}

func TestDaemonShutsDownPromptlyWhenIdle(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	cfg := &projectConfig{
		Root: root,
		Tasks: map[string]*entry{
			"brief": {Command: "sleep 0.4"},
		},
	}
	paths, err := newRuntimePaths(root)
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		done <- runDaemonClient(
			context.Background(),
			cfg,
			"brief",
			strings.NewReader(""),
			io.Discard,
			io.Discard,
		)
	}()
	waitFor(t, 3*time.Second, func() bool {
		return pathExists(paths.pid) && pathExists(paths.socket)
	})
	if err := waitResult(t, done); err != nil {
		t.Fatal(err)
	}
	waitFor(t, 3*time.Second, func() bool {
		return !pathExists(paths.pid) && !pathExists(paths.socket)
	})
}

func TestIncompatibleClientCannotReplaceActiveDaemon(t *testing.T) {
	root := t.TempDir()
	useIsolatedRuntime(t)
	ready := root + "/ready"
	pidFile := root + "/service.pid"
	cfg := directServiceConfig(root, "db", ready, pidFile, nil)
	t.Cleanup(func() { stopTestDaemon(cfg.Root) })

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	activeDone := make(chan error, 1)
	go func() {
		activeDone <- runDaemonClient(
			ctx,
			cfg,
			"db",
			strings.NewReader(""),
			io.Discard,
			io.Discard,
		)
	}()
	waitFor(t, 5*time.Second, func() bool { return pathExists(ready) })
	servicePID := readPID(t, pidFile)

	conn, err := connectDaemon(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(conn).Encode(clientMessage{
		Version: protocolVersion + 1,
		Type:    "run",
		Name:    "db",
		Digest:  configDigest(cfg),
		Config:  cfg,
	}); err != nil {
		t.Fatal(err)
	}
	var event daemonEvent
	if err := json.NewDecoder(conn).Decode(&event); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()
	if !strings.Contains(event.Error, "incompatible") {
		t.Fatalf("protocol mismatch event = %#v", event)
	}
	if !testProcessAlive(servicePID) || !pathExists(ready) {
		t.Fatal("incompatible client disturbed the active daemon or its service")
	}
	select {
	case err := <-activeDone:
		t.Fatalf("active compatible client exited: %v", err)
	default:
	}

	cancel()
	if err := waitResult(t, activeDone); err == nil || !strings.Contains(err.Error(), "context canceled") {
		t.Fatalf("active client cancellation error = %v", err)
	}
}

func TestServicesStopInDependentOrder(t *testing.T) {
	manager := &serviceManager{cfg: &projectConfig{Tasks: map[string]*entry{
		"db":  {Lifecycle: "service", Command: "db", Healthcheck: "true"},
		"dev": {Lifecycle: "service", Command: "dev", Healthcheck: "true", DependsOn: []string{"db"}},
	}}}
	order := strings.Join(manager.serviceStopOrder(), ",")
	if order != "dev,db" {
		t.Fatalf("serviceStopOrder() = %q, want %q", order, "dev,db")
	}
}

func directServiceConfig(
	root, name, ready, pidFile string,
	dependencies []string,
) *projectConfig {
	return &projectConfig{
		Root: root,
		Tasks: map[string]*entry{
			name: serviceEntry(ready, pidFile, dependencies),
		},
	}
}

func serviceEntry(ready, pidFile string, dependencies []string) *entry {
	return &entry{
		Lifecycle: "service",
		Command: fmt.Sprintf(
			"trap 'rm -f %s; exit 0' TERM INT; echo $$ > %s; touch %s; while :; do sleep 1; done",
			shellQuote(ready), shellQuote(pidFile), shellQuote(ready),
		),
		Healthcheck: "test -f " + shellQuote(ready),
		DependsOn:   dependencies,
	}
}

func testConfig(root, ready, servicePort, taskPort string) *projectConfig {
	serviceCommand := fmt.Sprintf(
		"trap 'rm -f %s; exit 0' TERM INT; echo \"$TEST_PORT\" > %s; touch %s; while :; do sleep 1; done",
		shellQuote(ready), shellQuote(servicePort), shellQuote(ready),
	)
	return &projectConfig{
		Root:  root,
		Ports: []string{"TEST_PORT"},
		Tasks: map[string]*entry{
			"db": {
				Lifecycle:   "service",
				Command:     serviceCommand,
				Healthcheck: "test -f " + shellQuote(ready),
			},
			"migrate": {
				Command:   "echo \"$TEST_PORT\" > " + shellQuote(taskPort),
				DependsOn: []string{"db"},
			},
		},
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

func initTestRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	cmd := exec.Command("git", "init", "-q", root)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v: %s", err, output)
	}
	return root
}

func writeTestFile(t *testing.T, filename, contents string) {
	t.Helper()
	if err := os.WriteFile(filename, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
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
