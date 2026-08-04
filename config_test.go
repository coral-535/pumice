package main

import (
	"strings"
	"testing"
)

func TestServiceDefinitionValidation(t *testing.T) {
	tests := []struct {
		name       string
		definition serviceDefinition
		wantError  string
	}{
		{
			name: "valid",
			definition: serviceDefinition{
				Name: "db", Command: "database", Healthcheck: "database-ready", Ports: []string{"DB_PORT"},
			},
		},
		{name: "missing name", definition: serviceDefinition{Command: "db", Healthcheck: "true"}, wantError: "name cannot be empty"},
		{name: "missing command", definition: serviceDefinition{Name: "db", Healthcheck: "true"}, wantError: "must define command"},
		{name: "missing healthcheck", definition: serviceDefinition{Name: "db", Command: "db"}, wantError: "must define healthcheck"},
		{name: "invalid port", definition: serviceDefinition{Name: "db", Command: "db", Healthcheck: "true", Ports: []string{"BAD-PORT"}}, wantError: "valid environment"},
		{name: "duplicate port", definition: serviceDefinition{Name: "db", Command: "db", Healthcheck: "true", Ports: []string{"PORT", "PORT"}}, wantError: "more than once"},
		{name: "negative timeout", definition: serviceDefinition{Name: "db", Command: "db", Healthcheck: "true", HealthcheckTimeout: -1}, wantError: "cannot be negative"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.definition.validate()
			if test.wantError == "" && err != nil {
				t.Fatalf("validate() error = %v", err)
			}
			if test.wantError != "" && (err == nil || !strings.Contains(err.Error(), test.wantError)) {
				t.Fatalf("validate() error = %v, want containing %q", err, test.wantError)
			}
		})
	}
}

func TestDefinitionDigestCanonicalizesPortOrder(t *testing.T) {
	left := &serviceDefinition{Name: "db", Command: "db", Healthcheck: "true", Ports: []string{"Z_PORT", "A_PORT"}}
	right := &serviceDefinition{Name: "db", Command: "db", Healthcheck: "true", Ports: []string{"A_PORT", "Z_PORT"}}
	if definitionDigest(left) != definitionDigest(right) {
		t.Fatal("equivalent port sets produced different service definition hashes")
	}
}
