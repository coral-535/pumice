package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTemporaryServiceLifecycleAndPortInjection(t *testing.T) {
	root := t.TempDir()
	ready := filepath.Join(root, "ready")
	servicePort := filepath.Join(root, "service-port")
	taskPort := filepath.Join(root, "task-port")
	cfg := testConfig(root, ready, servicePort, taskPort)

	var output safeBuffer
	runner, err := newRunner(cfg, &output, &output)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Run(context.Background(), "migrate"); err != nil {
		t.Fatalf("Run() error = %v\noutput:\n%s", err, output.String())
	}

	serviceValue := strings.TrimSpace(readTestFile(t, servicePort))
	taskValue := strings.TrimSpace(readTestFile(t, taskPort))
	if serviceValue != taskValue {
		t.Fatalf("service port %q != task port %q", serviceValue, taskValue)
	}
	if port, err := strconv.Atoi(serviceValue); err != nil || port <= 0 {
		t.Fatalf("managed port = %q, want a positive integer", serviceValue)
	}
	waitFor(t, 2*time.Second, func() bool {
		_, err := os.Stat(ready)
		return os.IsNotExist(err)
	})

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

func TestSharedServiceAndDuplicateDirectInvocation(t *testing.T) {
	root := t.TempDir()
	ready := filepath.Join(root, "ready")
	servicePort := filepath.Join(root, "service-port")
	taskPort := filepath.Join(root, "task-port")
	cfg := testConfig(root, ready, servicePort, taskPort)

	directContext, cancelDirect := context.WithCancel(context.Background())
	defer cancelDirect()
	var directOutput safeBuffer
	direct, err := newRunner(cfg, &directOutput, &directOutput)
	if err != nil {
		t.Fatal(err)
	}
	directDone := make(chan error, 1)
	go func() { directDone <- direct.Run(directContext, "db") }()
	waitFor(t, 3*time.Second, func() bool {
		_, err := os.Stat(ready)
		return err == nil
	})

	var duplicateOutput safeBuffer
	duplicate, err := newRunner(cfg, &duplicateOutput, &duplicateOutput)
	if err != nil {
		t.Fatal(err)
	}
	err = duplicate.Run(context.Background(), "db")
	if err == nil || !strings.Contains(err.Error(), "already running in this worktree") {
		t.Fatalf("duplicate Run() error = %v", err)
	}

	var taskOutput safeBuffer
	task, err := newRunner(cfg, &taskOutput, &taskOutput)
	if err != nil {
		t.Fatal(err)
	}
	if err := task.Run(context.Background(), "migrate"); err != nil {
		t.Fatalf("dependent Run() error = %v\noutput:\n%s", err, taskOutput.String())
	}
	if _, err := os.Stat(ready); err != nil {
		t.Fatalf("shared service stopped while direct invocation still needed it: %v", err)
	}
	if !strings.Contains(taskOutput.String(), "Using existing db service.") {
		t.Fatalf("dependent output did not report reuse:\n%s", taskOutput.String())
	}
	if !strings.Contains(taskOutput.String(), "db remains active because it is still required by db.") {
		t.Fatalf("dependent output did not report active owner:\n%s", taskOutput.String())
	}

	cancelDirect()
	select {
	case err := <-directDone:
		if err == nil || !strings.Contains(err.Error(), "context canceled") {
			t.Fatalf("direct Run() error = %v, want context cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("direct service did not stop after cancellation")
	}
	waitFor(t, 2*time.Second, func() bool {
		_, err := os.Stat(ready)
		return os.IsNotExist(err)
	})
}

func TestServicesStopInDependentOrder(t *testing.T) {
	runner := &runner{cfg: &projectConfig{Tasks: map[string]*entry{
		"db":  {Lifecycle: "service", Command: "db", Healthcheck: "true"},
		"dev": {Lifecycle: "service", Command: "dev", Healthcheck: "true", DependsOn: []string{"db"}},
	}}}
	order := strings.Join(runner.serviceStopOrder(), ",")
	if order != "dev,db" {
		t.Fatalf("serviceStopOrder() = %q, want %q", order, "dev,db")
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
