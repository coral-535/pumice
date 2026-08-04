package main

const protocolVersion = 2

type clientMessage struct {
	Version    int                `json:"version,omitempty"`
	Type       string             `json:"type"`
	Definition *serviceDefinition `json:"definition,omitempty"`
	ConfigHash string             `json:"configHash,omitempty"`
}

type daemonEvent struct {
	Type        string            `json:"type"`
	Error       string            `json:"error,omitempty"`
	Generation  uint64            `json:"generation,omitempty"`
	Environment map[string]string `json:"environment,omitempty"`
}
