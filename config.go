package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var environmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// serviceDefinition is the complete, immutable description of one service
// acquisition. Vite Task owns dependencies; Pumice deliberately has no task
// graph or finite-command representation.
type serviceDefinition struct {
	Name               string   `json:"name"`
	Command            string   `json:"command"`
	Healthcheck        string   `json:"healthcheck"`
	Ports              []string `json:"ports,omitempty"`
	HealthcheckTimeout int64    `json:"healthcheckTimeout,omitempty"`
}

func (d *serviceDefinition) validate() error {
	if strings.TrimSpace(d.Name) == "" {
		return errors.New("service name cannot be empty")
	}
	if strings.TrimSpace(d.Command) == "" {
		return fmt.Errorf("service %q must define command", d.Name)
	}
	if strings.TrimSpace(d.Healthcheck) == "" {
		return fmt.Errorf("service %q must define healthcheck", d.Name)
	}
	if d.HealthcheckTimeout < 0 {
		return fmt.Errorf("service %q healthcheckTimeout cannot be negative", d.Name)
	}
	seen := make(map[string]bool, len(d.Ports))
	for _, port := range d.Ports {
		if !environmentName.MatchString(port) {
			return fmt.Errorf("port %q is not a valid environment variable name", port)
		}
		if seen[port] {
			return fmt.Errorf("port %q is declared more than once", port)
		}
		seen[port] = true
	}
	return nil
}

func (d *serviceDefinition) timeout() time.Duration {
	if d.HealthcheckTimeout == 0 {
		return 30 * time.Second
	}
	return time.Duration(d.HealthcheckTimeout) * time.Millisecond
}

func (d *serviceDefinition) canonicalize() {
	d.Ports = append([]string(nil), d.Ports...)
	sort.Strings(d.Ports)
}

func definitionDigest(d *serviceDefinition) string {
	clone := *d
	clone.canonicalize()
	data, _ := json.Marshal(&clone)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func canonicalWorktree(start string) (string, error) {
	abs, err := filepath.Abs(start)
	if err != nil {
		return "", fmt.Errorf("resolve working directory: %w", err)
	}
	cmd := exec.Command("git", "-C", abs, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("determine Git worktree: %w", err)
	}
	root := strings.TrimSpace(string(out))
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("canonicalize Git worktree: %w", err)
	}
	return filepath.Clean(root), nil
}
