# Pumice Rewrite Handoff

Pumice is now a Vite Task service runtime, not a CLI task runner.

## Public package surface

- `definePumice({ ports })`
- `pumice.service({ command, healthcheck, healthcheckTimeout? })`
- `isPumiceService(value)`
- `normalizePumiceTasks(tasks)`

The npm package exports only the JavaScript/TypeScript API and the generated
`pumice-internal` binary shim. The old `pum`, `pumice-cli`, `pum run`, YAML
configuration, finite commands, and Pumice-owned dependency graph are gone.

## Main runtime files

- `npm/index.js` and `npm/index.d.ts`: branded descriptor API and task-map
  normalization.
- `main.go`: internal lease-holder, daemon, and process-guard dispatch.
- `client.go`: daemon startup serialization, acquisition, readiness forwarding,
  and socket-lifetime lease.
- `daemon.go`: worktree socket, protocol validation, and one lease per client.
- `runner.go`: ports, slots, generations, readiness, coalescing, failures, and
  zero-lease shutdown.
- `managed_process.go`: daemon-death pipe and process-group cleanup.
- `registry.go`: canonical-worktree runtime paths and private directory checks.
- `protocol.go`: protocol v2 acquisition/readiness/failure messages.

## Verification

```sh
GOCACHE=/tmp/pumice-go-cache go test -race ./...
GOCACHE=/tmp/pumice-go-cache go vet ./...
node npm/index.test.js
```

The Go integration tests create ephemeral TCP listeners and Unix sockets, so
they need ordinary local socket permissions in restricted sandboxes.
