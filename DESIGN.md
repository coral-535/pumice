# Pumice Shared-Service Task Runner: V1 Design Plan

## Goal

Pumice should let developers run tasks from multiple terminals and Git worktrees without manually starting shared development services, selecting ports, or editing environment files.

The primary experience should be:

```sh
pum run dev
pum run db:migrate
```

Pumice automatically starts, reuses, and stops any required services.

## Runtime architecture

Each canonical Git worktree has one short-lived Pumice daemon. CLI processes
connect to that daemon over a user-only Unix socket; they never launch or own
project commands directly.

The daemon is the single authority for:

* service-name locks and startup state;
* invocation references and dependency relationships;
* managed port values;
* command, service, and health-check processes; and
* propagation of service exits to dependents.

A service lock covers `starting`, `healthy`, and `stopping` states. The daemon
reserves the service name atomically before it launches the process and does
not release it until process-group shutdown completes, so concurrent requests
cannot overlap service instances even when the service has no port.

Every command is launched through a small process supervisor with a private
lease pipe held by the daemon. If the daemon exits or is killed, the kernel
closes every lease and the supervisors kill their complete command process
groups. Likewise, each CLI connection is an invocation lease: disconnecting a
CLI immediately releases its service references.

Health checks establish readiness only. They are not used for ownership,
locking, or detecting whether a known process exited.

## Core concepts

Pumice has two kinds of runnable entries:

* **Task:** A finite command that satisfies dependencies by completing successfully.
* **Service:** A long-running command that satisfies dependencies once its health check succeeds.

Both live in the same task namespace and use `depends_on`.

```yaml
ports:
  - PGLITE_DB_PORT
  - DEV_SERVER_PORT

tasks:
  db:
    lifecycle: service
    command: pglite-server --port $PGLITE_DB_PORT
    healthcheck: pg_isready --dbname postgresql://postgres:postgres@127.0.0.1:$PGLITE_DB_PORT/postgres

  dev:
    lifecycle: service
    command: vp dev --port $DEV_SERVER_PORT --host
    healthcheck: curl -f http://127.0.0.1:$DEV_SERVER_PORT/health
    depends_on:
      - db

  db:migrate:
    command: pnpm run db:migrate
    depends_on:
      - db
```

A regular entry is a task by default. `lifecycle: service` marks a long-running shared service.

## Dependency semantics

The meaning of `depends_on` depends on the referenced entry:

* When depending on a task, wait for it to complete successfully.
* When depending on a service, start or reuse it and wait for its health check to succeed.

A service remains running while at least one active command requires it.

If a service process exits, the daemon immediately stops every running service
that transitively depends on it and fails their active invocations. This is
driven by process-exit events rather than health checks.

## Direct service execution

When a user directly runs a service:

```sh
pum run dev
```

Pumice should:

1. Start its dependencies.
2. Wait for those dependencies to become healthy.
3. Start the requested service.
4. Show its output in the current terminal.
5. Keep it running until the command is terminated.

A directly invoked service must not be stopped merely because another dependent task finishes.

When the user terminates the direct invocation, Pumice stops the service only when nothing else still depends on it.

## Services used as dependencies

When a service is started only because a task depends on it:

```sh
pum run db:migrate
```

Pumice should:

1. Start or reuse `db`.
2. Wait until `db` is healthy.
3. Run `db:migrate`.
4. Stop `db` after the migration finishes, but only when no other active command requires it.

If `dev` is already using `db`, the migration must reuse the same database and must not stop it afterward.

## Duplicate direct invocation

Pumice V1 will not support attaching a second terminal to an already-running service.

```sh
# Terminal 1
pum run dev

# Terminal 2
pum run dev
```

The second command should fail clearly:

```text
Service "dev" is already running in this worktree.
Attaching to an existing service is not supported.
```

This restriction applies only to directly running the same service again. Other tasks may still reuse that service as a dependency.

## Health checks

For V1, “healthy” and “ready” mean the same thing.

A service becomes available when its health check exits successfully. All tasks that depend on that service must wait for the same health check before starting.

## Ports and environment values

Top-level `ports` declares named, worktree-scoped ports managed by Pumice.

Pumice injects these values into commands and health checks through environment variables. Each Git worktree receives independent values, so different worktrees cannot accidentally share the same service.

Ports do not need to remain numerically identical after a service has fully stopped. They only need to remain consistent among concurrent commands using the same active service.

Pumice should remain unaware of application-specific concepts such as `DATABASE_URL`. Projects can construct such values themselves from the injected environment variables.

## Worktree isolation

Services are shared only within the same canonical Git worktree.

Running the same service in two separate worktrees must produce two independent service instances and independent port values.

Moving or copying a worktree must invalidate its previous local Pumice identity so it cannot accidentally connect to a service belonging to the original path.

## User-visible lifecycle output

Pumice should explain significant lifecycle events without overwhelming normal command output:

```text
Starting db...
Waiting for db to become healthy...
db is healthy.
Running db:migrate...
db:migrate completed.
Stopping db because it is no longer required.
```

When reusing a service:

```text
Using existing db service.
```

When a service remains active after another command exits:

```text
db remains active because it is still required by dev.
```

## V1 exclusions

Pumice V1 will not support:

* A second direct invocation of an already-running service.
* Multiple instances of the same named service within one worktree.
* Automatically restarting a failed service.
* Attaching to an existing service’s logs from another terminal.

## Acceptance scenarios

### Temporary database

```sh
pum run db:migrate
```

Pumice starts `db`, runs the migration after it becomes healthy, and stops `db` afterward.

### Shared database

```sh
# Terminal 1
pum run dev

# Terminal 2
pum run db:migrate
```

Both commands use the same database instance and port. Completing the migration does not stop the database.

### Direct database invocation

```sh
# Terminal 1
pum run db

# Terminal 2
pum run db:migrate
```

The migration reuses the directly running database. The database remains active after the migration finishes.

### Worktree isolation

Running `pum run dev` in two different worktrees creates independent `dev` and `db` services with independent ports.

### Duplicate service invocation

Running `pum run dev` twice in the same worktree causes the second direct invocation to fail without affecting the first.

### Concurrent cold start

Running two tasks that both require a stopped service starts exactly one
instance. Both requests wait on the same daemon-owned startup record.

### Client crash

Killing a CLI process closes its daemon connection. Its references are released
immediately, and any service with no remaining users is stopped.

### Dependency crash

If a service exits unexpectedly, all transitive dependent services are stopped
and their CLI invocations fail, independently of configured health checks.

### Daemon crash

Killing the worktree daemon closes all process leases and client connections.
Every managed process group and every listening CLI terminates immediately.
