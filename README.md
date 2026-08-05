# Pumice

Pumice keeps worktree-scoped development services alive while a finite command
uses them. One daemon directly owns the service process groups. A
`ServiceGuard` connection owns the references acquired through it, and closing
that connection releases them atomically.

Both resources surrounding a run are async-disposable:

```js
import { ServiceGuard, startCommand } from "pumice-cli";

await using guard = await ServiceGuard.connect(process.cwd());
await guard.run({
  services: [{
    name: "database",
    command: "database --port 5432",
    healthcheck: "database-ready --port 5432",
  }],
});

await using command = startCommand("pnpm test");
const outcome = await Promise.race([
  command.exited,
  guard.failure.then((error) => { throw error; }),
]);
```

`run()` provides the complete policy: it waits for service readiness, starts
the command, terminates the command's process group if a required service dies,
waits for that group to exit, and finally releases the guard.

```js
import { run } from "pumice-cli";

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

Pumice currently uses POSIX process groups for descendant cleanup. On Windows,
termination is limited to the direct child until Job Object containment is
implemented.
