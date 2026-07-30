package main

const protocolVersion = 1

type clientMessage struct {
	Version int            `json:"version,omitempty"`
	Type    string         `json:"type"`
	Name    string         `json:"name,omitempty"`
	Digest  string         `json:"digest,omitempty"`
	Config  *projectConfig `json:"config,omitempty"`
	Data    []byte         `json:"data,omitempty"`
}

type daemonEvent struct {
	Type     string `json:"type"`
	Stream   string `json:"stream,omitempty"`
	Data     []byte `json:"data,omitempty"`
	Error    string `json:"error,omitempty"`
	ExitCode int    `json:"exit_code,omitempty"`
}
