# Pumice

Pumice (`pum`) is a service-aware task runner. It starts, shares, and stops
development services as tasks need them, including across terminals in the
same Git worktree.

## Build

Pumice supports Go 1.26.5, the current stable Go release.

```sh
go build -o pum .
```

## Install

Pumice is published as `pumice-cli` with prebuilt Linux and macOS binaries for
x64 and ARM64. Install the alpha release with npm or pnpm:

```sh
npm install --global pumice-cli@alpha
# or
pnpm add --global pumice-cli@alpha
```

The package installs the `pum` command.

## Configuration

Create `pumice.yaml` (or `pumice.yml`) in your Git worktree:

```yaml
ports:
  - DATABASE_PORT
  - DEV_SERVER_PORT

tasks:
  db:
    lifecycle: service
    command: pglite-server --port "$DATABASE_PORT"
    healthcheck: pg_isready --dbname "postgresql://127.0.0.1:$DATABASE_PORT/postgres"

  dev:
    lifecycle: service
    command: vp dev --port "$DEV_SERVER_PORT" --host
    healthcheck: curl -f "http://127.0.0.1:$DEV_SERVER_PORT/health"
    depends_on:
      - db

  db:migrate:
    command: pnpm run db:migrate
    depends_on:
      - db
```

Run a task or service:

```sh
pum run db:migrate
pum run dev
```

Regular tasks wait for task dependencies to finish and service dependencies
to become healthy. Services are reused by concurrent commands in the same
canonical worktree and stopped when their last user exits. Managed ports are
injected into commands and health checks as environment variables.

See [DESIGN.md](DESIGN.md) for the V1 behavior and acceptance scenarios.
