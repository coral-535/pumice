# Pumice Daemon Architecture Handoff

## Runtime model

Pumice now uses a worktree-scoped daemon instead of coordinating independent
CLI process owners through a JSON registry.

The CLI loads and validates `pumice.yaml`, connects to the daemon over a
permission-restricted Unix socket, and proxies stdin/stdout/stderr. The daemon
is the sole owner of:

- service locks, including the `starting` state;
- active invocation references;
- service dependency state;
- managed ports; and
- every task, service, and health-check process.

The daemon exits after ten idle seconds. A startup flock and a lifetime flock
prevent daemon startup races.

## Failure guarantees

Every project command runs behind the internal `_exec` supervisor. The daemon
holds the write side of a private lease pipe and the supervisor holds the read
side. An unexpected daemon exit closes the lease in the kernel, causing the
supervisor to kill the command's process group. This mechanism is portable
across the supported Unix platforms and does not rely solely on Linux parent
death signals.

The client connection is also a lease. EOF immediately cancels its invocation
and releases all service references. An unexpected service exit is observed
through `Wait`, not a health check; the daemon stops transitive dependent
services and cancels every affected invocation.

## Locking

The daemon inserts a service record while holding its manager mutex before
launching the process. That record is the service-name lock for startup,
running, and shutdown; it is removed only after process-group termination
completes. Concurrent dependency requests wait on the same readiness channel.
A direct duplicate request fails clearly.

Ports are values managed by the daemon, not locks.

## Main files

- `main.go`: public CLI and dispatch for internal daemon/supervisor modes.
- `client.go`: daemon startup serialization, IPC client, and stdio proxying.
- `daemon.go`: Unix socket server, configuration epochs, connection leases,
  and bounded asynchronous stdin relay.
- `runner.go`: daemon-owned service manager, atomic service locking,
  references, health readiness, exit propagation, and shutdown ordering.
- `managed_process.go`: process lease supervisor and process-group shutdown.
- `registry.go`: secure worktree runtime-path derivation.
- `protocol.go`: versioned client/daemon wire messages.
- `runner_test.go`: black-box concurrency and crash regression tests.

## Verification

The integration suite covers:

- temporary dependency lifecycle and port injection;
- simultaneous cold-start locking;
- abrupt client disconnect;
- dependency-process death;
- daemon `SIGKILL`; and
- dependent-before-dependency shutdown order.

Run:

```sh
go test -race ./...
go vet ./...
go build ./...
```

The tests create Unix sockets and ephemeral localhost listeners, which can
require extra permission in a restricted sandbox.
