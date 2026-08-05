import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import {
  DaemonDisconnectedError,
  DaemonServer,
  ServiceConfigurationError,
  ServiceExitedError,
  ServiceGuard,
  ServiceStartupError,
  run,
  startCommand,
  type DaemonEvent,
  type ServiceDefinition,
  type ServiceGuardOptions,
} from "../src/core/index.ts";
import { resolveRuntime } from "../src/core/runtime.ts";

const FIXTURES = fileURLToPath(new URL("fixtures/", import.meta.url));
const SERVICE_FIXTURE = join(FIXTURES, "service.js");
const COMMAND_FIXTURE = join(FIXTURES, "command.js");
const CHECK_FIXTURE = join(FIXTURES, "check-file.js");
const FINITE_FIXTURE = join(FIXTURES, "finite-command.js");
const IGNORE_TERM_FIXTURE = join(FIXTURES, "ignore-term.js");

test("RunningCommand async disposal terminates and awaits its process group", async () => {
  await using temporary = await temporaryDirectory();
  const started = join(temporary.path, "command.pid");
  const stopped = join(temporary.path, "command.stopped");
  const command = startCommand(nodeCommand(COMMAND_FIXTURE, started, stopped, "80"));

  await waitForFile(started);
  const before = Date.now();
  await command[Symbol.asyncDispose]();

  assert.ok(Date.now() - before >= 60, "disposal should await the signal handler");
  assert.equal(await readFile(stopped, "utf8"), "stopped");
});

test("RunningCommand disposal escalates after its grace period", async () => {
  const command = startCommand({
    command: nodeCommand(IGNORE_TERM_FIXTURE),
    stdio: "ignore",
    terminationGracePeriod: 40,
  });
  await new Promise((resolve) => setTimeout(resolve, 80));

  const before = Date.now();
  await Promise.all([command[Symbol.asyncDispose](), command[Symbol.asyncDispose]()]);
  await command.exited;

  assert.ok(Date.now() - before >= 30);
  assert.notEqual(command.pid, undefined);
  const pid = command.pid as number;
  assert.throws(
    () => process.kill(-pid, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
  );
});

test("guards share a generation and only the final disposal stops it", async () => {
  await using fixture = await daemonFixture();
  const definition = serviceDefinition(fixture.path, { readyDelay: 80 });
  const guardOne = await fixture.connect();
  const guardTwo = await fixture.connect();

  const [one, two] = await Promise.all([
    guardOne.run({ services: [definition] }),
    guardTwo.run({ services: [definition] }),
  ]);
  assert.equal(one.services[0].generation, two.services[0].generation);
  assert.equal(fixture.daemon.serviceCount, 1);

  await guardOne[Symbol.asyncDispose]();
  assert.equal(fixture.daemon.serviceCount, 1);
  assert.equal(await fileExists(definition.stoppedPath), false);

  await guardTwo[Symbol.asyncDispose]();
  await waitForFile(definition.stoppedPath);
  assert.equal(fixture.daemon.serviceCount, 0);
});

test("an active service name rejects a conflicting definition", async () => {
  await using fixture = await daemonFixture();
  await using first = await fixture.connect();
  await using second = await fixture.connect();
  const definition = serviceDefinition(fixture.path);
  await first.run([definition]);

  await assert.rejects(
    second.run([{ ...definition, command: `${definition.command} --different` }]),
    ServiceConfigurationError,
  );
});

test("startup failure stops the partial service and rejects acquisition", async () => {
  await using fixture = await daemonFixture();
  await using guard = await fixture.connect();
  const definition = serviceDefinition(fixture.path, {
    readyDelay: 10_000,
    healthcheckTimeout: 150,
  });

  await assert.rejects(guard.run([definition]), ServiceStartupError);
  await waitForFile(definition.stoppedPath);
  assert.equal(fixture.daemon.serviceCount, 0);
});

test("a late service exit reaches listeners and resolves guard.failure", async () => {
  await using fixture = await daemonFixture();
  await using guard = await fixture.connect();
  const definition = serviceDefinition(fixture.path, { exitDelay: 250 });
  const events: DaemonEvent[] = [];
  using _listener = guard.onEvent((event) => events.push(event));

  await guard.run([definition]);
  const failure = await guard.failure;

  assert.ok(failure instanceof ServiceExitedError);
  assert.equal(failure.exitCode, 23);
  assert.deepEqual(
    events.map((event) => event.type),
    ["service-exited"],
  );
});

test("run disposes and awaits the command before releasing the guard", async () => {
  await using fixture = await daemonFixture();
  const definition = serviceDefinition(fixture.path, { exitDelay: 300 });
  const commandStarted = join(fixture.path, "consumer.pid");
  const commandStopped = join(fixture.path, "consumer.stopped");

  await assert.rejects(
    run(
      fixture.path,
      [definition],
      {
        command: nodeCommand(COMMAND_FIXTURE, commandStarted, commandStopped, "100"),
        stdio: "ignore",
      },
      fixture.connectionOptions,
    ),
    ServiceExitedError,
  );

  assert.equal(await readFile(commandStopped, "utf8"), "stopped");
  assert.equal(fixture.daemon.connectionCount, 0);
});

test("normal command exit releases the service and preserves its result", async () => {
  await using fixture = await daemonFixture();
  const definition = serviceDefinition(fixture.path);
  const commandStarted = join(fixture.path, "finite.started");

  const result = await run(
    fixture.path,
    [definition],
    {
      command: nodeCommand(FINITE_FIXTURE, commandStarted, "80", "7"),
      stdio: "ignore",
    },
    fixture.connectionOptions,
  );

  assert.equal(result.code, 7);
  await waitForFile(definition.stoppedPath);
  assert.equal(fixture.daemon.connectionCount, 0);
});

test("unexpected daemon closure is a terminal guard failure", async () => {
  await using fixture = await daemonFixture();
  await using guard = await fixture.connect();
  const definition = serviceDefinition(fixture.path);
  const events: DaemonEvent[] = [];
  using _listener = guard.onEvent((event) => events.push(event));
  await guard.run([definition]);

  await fixture.daemon.close();
  const failure = await guard.failure;

  assert.ok(failure instanceof DaemonDisconnectedError);
  assert.deepEqual(
    events.map((event) => event.type),
    ["daemon-disconnected"],
  );
});

test("ServiceGuard starts and retires the canonical worktree daemon", async () => {
  await using temporary = await temporaryDirectory();
  const runtime = await resolveRuntime(temporary.path);
  const guard = await ServiceGuard.connect(temporary.path);
  await guard.run([]);
  await guard[Symbol.asyncDispose]();

  await waitForMissing(runtime.socketPath, 3_000);
  await waitForMissing(runtime.lockPath, 3_000);
});

interface TestServiceDefinition extends ServiceDefinition {
  stoppedPath: string;
}

interface ServiceDefinitionOptions {
  suffix?: string;
  name?: string;
  readyDelay?: number;
  exitDelay?: number;
  healthcheckTimeout?: number;
}

function serviceDefinition(
  directory: string,
  options: ServiceDefinitionOptions = {},
): TestServiceDefinition {
  const suffix = options.suffix ?? "service";
  const readyPath = join(directory, `${suffix}.ready`);
  const pidPath = join(directory, `${suffix}.pid`);
  const stoppedPath = join(directory, `${suffix}.stopped`);
  return {
    name: options.name ?? "database",
    command: nodeCommand(
      SERVICE_FIXTURE,
      readyPath,
      pidPath,
      stoppedPath,
      String(options.readyDelay ?? 0),
      String(options.exitDelay ?? -1),
    ),
    healthcheck: nodeCommand(CHECK_FIXTURE, readyPath),
    healthcheckTimeout: options.healthcheckTimeout ?? 2_000,
    cwd: directory,
    stoppedPath,
  };
}

async function daemonFixture() {
  const temporary = await temporaryDirectory();
  const socketPath = join(temporary.path, "daemon.sock");
  const daemon = await new DaemonServer({ socketPath }).listen();
  const connectionOptions: ServiceGuardOptions = { socketPath, startDaemon: false };
  return {
    path: temporary.path,
    daemon,
    connectionOptions,
    connect: () => ServiceGuard.connect(temporary.path, connectionOptions),
    async [Symbol.asyncDispose]() {
      await daemon.close();
      await temporary[Symbol.asyncDispose]();
    },
  };
}

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "pumice-test-"));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function nodeCommand(script: string, ...arguments_: string[]): string {
  return [process.execPath, script, ...arguments_].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function waitForFile(path: string, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fileExists(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForMissing(path: string, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await fileExists(path))) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path} to disappear`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
