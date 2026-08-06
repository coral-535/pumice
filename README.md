# Pumice

Pumice keeps worktree-scoped development services alive while a finite command
uses them. One daemon directly owns the service process groups. A
`ServiceGuard` connection owns the references acquired through it, and closing
that connection releases them atomically.

Both resources surrounding a run are async-disposable:

```js
import { ServiceGuard, startCommand } from "pumice-cli/core";

await using guard = await ServiceGuard.connect(process.cwd());
await guard.run({
  services: [
    {
      name: "database",
      command: "database --port 5432",
      healthcheck: "database-ready --port 5432",
    },
  ],
});

await using command = startCommand("pnpm test");
const outcome = await Promise.race([
  command.exited,
  guard.failure.then((error) => {
    throw error;
  }),
]);
```

`run()` provides the complete policy: it waits for service readiness, starts
the command, terminates the command's process group if a required service dies,
waits for that group to exit, and finally releases the guard.

```js
import { run } from "pumice-cli/core";

const result = await run(
  process.cwd(),
  { services: [{ name: "database", command: "database", healthcheck: "database-ready" }] },
  { command: "pnpm test" },
);
```

Services with the same name and definition share one generation. Acquiring an
active name with a different definition fails. Unexpected service exits and
daemon disconnects are terminal for every affected guard. There is no automatic
restart policy.

## Vite Task integration

`definePumice()` compiles a service chain and finite command into an immutable,
content-addressed manifest. The returned task runs the Node wrapper shipped in
this package, so there is no separate Pumice task executable to install:

```ts
import { definePumice } from "pumice-cli";

const pumice = definePumice({
  ports: ["DATABASE_PORT"],
  services: {
    db: {
      command: "pglite-server --port $DATABASE_PORT",
      healthcheck: "pg_isready --port $DATABASE_PORT",
    },
  },
});

const db = pumice.service("db");

export default defineConfig({
  run: {
    tasks: {
      migrate: db.task({ command: "pnpm drizzle-kit migrate" }),
    },
  },
});
```

Nested handles compose dependencies. In this example, `api.task()` starts and
health-checks `db`, then `api`, before it starts the finite command:

```ts
const api = db.service({
  name: "api",
  command: "node apps/api/server.mjs --port $API_PORT",
  healthcheck: "curl -f http://127.0.0.1:$API_PORT/health",
  ports: ["API_PORT"],
});
```

Generated manifests live under
`node_modules/.cache/pumice/manifests/<sha256>.json`. Equivalent plans reuse the
same file, while any plan change produces a new path. The generated Vite Task
definition defaults to `cache: false`; extra arguments passed by Vite Task are
forwarded to the real command as distinct argv values.

Each wrapper owns one service lease. Strictly sequential Vite Task nodes can
therefore stop and restart a service between nodes when no other wrapper holds
a reference. A run-level lease spanning multiple task nodes is outside v1.

Pumice currently uses POSIX process groups for descendant cleanup. On Windows,
termination is limited to the direct child until Job Object containment is
implemented.

## Development

The project uses the Vite+ TypeScript library structure:

```sh
vp install
vp check
vp test
vp pack
```

`vp pack` emits the library, generated declarations, source maps, and the
`pumice-daemon` executable into `dist/`.

Pre-commit checks are installed by `vp config --no-agent`. The committed
`.vite-hooks/pre-commit` hook runs `vp staged`, which applies `vp check --fix`
to staged files using `vite.config.ts`.

## Publishing

Update the version with `vp run bump`, then choose one of the Vite+ publishing
flows:

```sh
# Build and publish directly through the detected package manager
vp run release

# Upload a CI-friendly staged release, then approve it from a trusted device
vp run release:stage
vp pm stage list
vp pm stage approve <stage-id>
```

Both release scripts run checks, tests, and `vp pack` first. Publishing also
invokes `prepublishOnly`, ensuring `dist/` is rebuilt from the tagged source.
