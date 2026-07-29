package main

import (
	"strings"
	"testing"
)

func TestConfigValidation(t *testing.T) {
	tests := []struct {
		name    string
		config  projectConfig
		wantErr string
	}{
		{
			name: "valid",
			config: projectConfig{
				Ports: []string{"DB_PORT"},
				Tasks: map[string]*entry{
					"db":      {Lifecycle: "service", Command: "db", Healthcheck: "check"},
					"migrate": {Command: "migrate", DependsOn: []string{"db"}},
				},
			},
		},
		{
			name: "service needs healthcheck",
			config: projectConfig{
				Tasks: map[string]*entry{
					"db": {Lifecycle: "service", Command: "db"},
				},
			},
			wantErr: "must define healthcheck",
		},
		{
			name: "port must be an environment name",
			config: projectConfig{
				Ports: []string{"NOT-A-VARIABLE"},
				Tasks: map[string]*entry{"task": {Command: "true"}},
			},
			wantErr: "valid environment variable",
		},
		{
			name: "unknown dependency",
			config: projectConfig{
				Tasks: map[string]*entry{
					"dev": {Command: "dev", DependsOn: []string{"missing"}},
				},
			},
			wantErr: "unknown task",
		},
		{
			name: "cycle",
			config: projectConfig{
				Tasks: map[string]*entry{
					"a": {Command: "a", DependsOn: []string{"b"}},
					"b": {Command: "b", DependsOn: []string{"a"}},
				},
			},
			wantErr: "dependency cycle",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.config.validate()
			if test.wantErr == "" && err != nil {
				t.Fatalf("validate() error = %v", err)
			}
			if test.wantErr != "" && (err == nil || !strings.Contains(err.Error(), test.wantErr)) {
				t.Fatalf("validate() error = %v, want containing %q", err, test.wantErr)
			}
		})
	}
}

func TestYAMLConfigRejectsUnknownFields(t *testing.T) {
	root := initTestRepo(t)
	writeTestFile(t, root+"/pumice.yaml", `
tasks:
  hello:
    command: echo hello
    typo: true
`)
	_, err := loadProjectConfig(root)
	if err == nil || !strings.Contains(err.Error(), "field typo not found") {
		t.Fatalf("loadProjectConfig() error = %v", err)
	}
}
