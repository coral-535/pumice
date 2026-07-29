# Pumice

Pumice is a task runner for development services. It starts the services a task
depends on, waits until they are healthy, reuses services that are already
running in the same Git worktree, and stops them when they are no longer needed.

Pumice currently supports macOS and Linux on x64 and ARM64.

## Quick start

Add a `pumice.yaml` file to your project:

```yaml
ports:
  - DATABASE_PORT
  - DEV_PORT

tasks:
  database:
    lifecycle: service
    command: my-database --port $DATABASE_PORT
    healthcheck: database-ready --port $DATABASE_PORT

  dev:
    lifecycle: service
    command: pnpm dev --port $DEV_PORT
    healthcheck: curl --fail http://localhost:$DEV_PORT
    depends_on:
      - database

  db:migrate:
    command: pnpm db:migrate
    depends_on:
      - database
```

Run a task without installing Pumice:

```sh
pnpx --package=pumice-cli pum run dev
```

Pumice also works with `npx`:

```sh
npx --package=pumice-cli -- pum run dev
```

Replace `dev` with any task defined in `pumice.yaml` or `pumice.yml`:

```sh
pnpx --package=pumice-cli pum run db:migrate
```

## Add Pumice to your package scripts

Install Pumice as a development dependency:

```sh
pnpm add --save-dev pumice-cli
```

Or with npm:

```sh
npm install --save-dev pumice-cli
```

Then call the `pum` executable from `package.json`:

```json
{
  "scripts": {
    "dev": "pum run dev",
    "db:migrate": "pum run db:migrate"
  }
}
```

Run the scripts with your package manager:

```sh
pnpm dev
pnpm db:migrate
```

The equivalent npm commands are `npm run dev` and `npm run db:migrate`.

## Configuration

Pumice searches the current directory and its parents for `pumice.yaml` or
`pumice.yml`.

- A task runs its `command` and exits.
- A service uses `lifecycle: service` and must define a `healthcheck`.
- `depends_on` lists tasks or services that must be ready first.
- `ports` lists environment variables for worktree-specific ports. Pumice
  assigns their values and makes them available to commands and health checks.
