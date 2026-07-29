package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

type projectConfig struct {
	Ports    []string         `yaml:"ports"`
	Tasks    map[string]*entry `yaml:"tasks"`
	Root     string           `yaml:"-"`
	Filename string           `yaml:"-"`
}

type entry struct {
	Lifecycle  string   `yaml:"lifecycle"`
	Command    string   `yaml:"command"`
	Healthcheck string  `yaml:"healthcheck"`
	DependsOn  []string `yaml:"depends_on"`
}

func (e *entry) isService() bool {
	return e.Lifecycle == "service"
}

func loadProjectConfig(start string) (*projectConfig, error) {
	filename, err := findConfig(start)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", filename, err)
	}

	var cfg projectConfig
	decoder := yaml.NewDecoder(strings.NewReader(string(data)))
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", filename, err)
	}
	cfg.Filename = filename
	cfg.Root, err = canonicalWorktree(filepath.Dir(filename))
	if err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", filename, err)
	}
	return &cfg, nil
}

func findConfig(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		for _, name := range []string{"pumice.yaml", "pumice.yml"} {
			candidate := filepath.Join(dir, name)
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return candidate, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", errors.New("no pumice.yaml or pumice.yml found in this directory or its parents")
}

func canonicalWorktree(configDir string) (string, error) {
	cmd := exec.Command("git", "-C", configDir, "rev-parse", "--show-toplevel")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("determine Git worktree: %w", err)
	}
	root := strings.TrimSpace(string(out))
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("canonicalize worktree: %w", err)
	}
	return filepath.Clean(root), nil
}

func (c *projectConfig) validate() error {
	if len(c.Tasks) == 0 {
		return errors.New("tasks must contain at least one entry")
	}
	seenPorts := make(map[string]bool)
	for _, port := range c.Ports {
		if port == "" {
			return errors.New("port names cannot be empty")
		}
		if seenPorts[port] {
			return fmt.Errorf("port %q is declared more than once", port)
		}
		seenPorts[port] = true
	}

	names := make([]string, 0, len(c.Tasks))
	for name := range c.Tasks {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		task := c.Tasks[name]
		if task == nil {
			return fmt.Errorf("task %q has no configuration", name)
		}
		if name == "" {
			return errors.New("task names cannot be empty")
		}
		if task.Lifecycle != "" && task.Lifecycle != "service" {
			return fmt.Errorf("task %q has unsupported lifecycle %q", name, task.Lifecycle)
		}
		if strings.TrimSpace(task.Command) == "" {
			return fmt.Errorf("task %q must define command", name)
		}
		if task.isService() && strings.TrimSpace(task.Healthcheck) == "" {
			return fmt.Errorf("service %q must define healthcheck", name)
		}
		for _, dependency := range task.DependsOn {
			if _, ok := c.Tasks[dependency]; !ok {
				return fmt.Errorf("task %q depends on unknown task %q", name, dependency)
			}
		}
	}

	state := make(map[string]uint8)
	var visit func(string) error
	visit = func(name string) error {
		switch state[name] {
		case 1:
			return fmt.Errorf("dependency cycle includes %q", name)
		case 2:
			return nil
		}
		state[name] = 1
		for _, dependency := range c.Tasks[name].DependsOn {
			if err := visit(dependency); err != nil {
				return err
			}
		}
		state[name] = 2
		return nil
	}
	for _, name := range names {
		if err := visit(name); err != nil {
			return err
		}
	}
	return nil
}
