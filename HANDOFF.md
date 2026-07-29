# Pumice Go Implementation Handoff

## Objective

The user asked to implement the service described in `DESIGN.md` in Go. The
repository initially contained only `README.md`, `DESIGN.md`, `LICENSE`, and
`.gitignore`.

The implementation is complete.

## What Was Implemented

Pumice now provides a `pum run <task>` CLI with the V1 behavior described in
`DESIGN.md`:

- Loads `pumice.yaml` or `pumice.yml`, searching from the current directory
  upward.
- Validates commands, service health checks, dependencies, lifecycle values,
  environment-variable-style port names, and dependency cycles.
- Treats regular entries as finite tasks and `lifecycle: service` entries as
  long-running services.
- Executes dependencies in order and runs each dependency once per invocation.
- Waits for service health checks before starting dependents.
- Allocates worktree-scoped ports and injects them into commands and health
  checks as environment variables.
- Coordinates concurrent CLI processes through a locked JSON state file in
  the user runtime directory, with a `/tmp` fallback.
- Reuses services across terminals in the same canonical Git worktree.
- Tracks service users by invocation and stops a service after its last user
  exits.
- Stops dependent services before their service dependencies.
- Detects stale CLI/service processes during later registry access.
- Rejects a direct invocation when that service is already running, because
  V1 does not support attaching to existing logs.
- Runs services in separate process groups and terminates their descendants on
  shutdown.
- Shows direct-service output in the invoking terminal. Output from services
  started only as dependencies is discarded so those services can safely
  outlive the launching process without holding its output pipe open.
- Handles `SIGINT` and `SIGTERM`.

## Main Files

- `main.go`: CLI parsing, signal context, error reporting, and exit codes.
- `config.go`: YAML discovery, parsing, Git worktree canonicalization, and
  validation.
- `registry.go`: locked runtime state, port allocation, stale-state cleanup,
  atomic state writes, process checks, and process-group termination.
- `runner.go`: dependency execution, service startup/reuse, health checks,
  lifecycle messages, reference release, and shutdown ordering.
- `config_test.go`: configuration and YAML validation tests.
- `runner_test.go`: temporary-service, shared-service, duplicate-invocation,
  managed-port, lifecycle-output, and shutdown-order tests.
- `go.mod`: module `github.com/coral-535/pumice`, requiring Go 1.26.5.
- `go.sum`: checksums for `gopkg.in/yaml.v3` and its transitive module
  metadata.
- `README.md`: expanded build, configuration, and usage documentation.

## Verification Performed

The workspace uses the installed Go 1.26.5 toolchain.

The following completed successfully:

```sh
go test -race ./...
go vet ./...
go build -o /tmp/pum ./
git diff --check
/tmp/pum --version
```

The race-enabled test result was:

```text
ok github.com/coral-535/pumice
```

The lifecycle tests require permission to bind an ephemeral localhost socket
because managed ports are allocated with `127.0.0.1:0`. In this particular
sandbox, `go test` therefore had to run with elevated sandbox permission.

## Design Decisions and Caveats

- Runtime identity is a SHA-256-derived key of the canonical worktree path.
  Moving or copying a worktree therefore yields a different runtime identity.
- State is written beneath `$XDG_RUNTIME_DIR/pumice` when writable, otherwise
  beneath `/tmp/pumice-<uid>`.
- Health-check timeout is currently fixed at 30 seconds with a 200 ms retry
  interval.
- Managed ports are selected by briefly binding an ephemeral localhost port
  and then releasing it. This follows the V1 requirement but retains the usual
  small bind race before the application claims the port.
- If a CLI process is killed with an uncatchable signal, its services are
  cleaned up lazily the next time another Pumice invocation accesses that
  worktree's registry.
- The implementation is Unix-oriented: it uses `sh`, `syscall.Flock`, Unix
  signals, and process groups.
- Directly running any already-active service fails, even if the existing
  instance was originally started as a dependency. This is consistent with
  the V1 inability to attach output to an existing process.
- Dependency-service output is discarded. If persistent dependency logs are
  desired, add per-service log files and expose their paths without reattaching
  the original invocation's pipes.

## Suggested Next Steps

1. Review the implementation and decide whether dependency-service logs should
   be persisted.
2. Add a true multi-process CLI acceptance test if stronger coverage of
   cross-terminal locking is desired; current integration tests exercise the
   shared registry and concurrent runners within one test process.
3. Consider configurable health-check timeout/interval only if the V1 schema
   should expand beyond `DESIGN.md`.
4. Run the tests on a normal developer machine with Go 1.26.5.
