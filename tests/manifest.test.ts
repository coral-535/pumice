import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { daemonEnvironment } from "../src/core/service-guard.ts";
import { normalizePlan } from "../src/core/definitions.ts";
import {
  manifestHash,
  readAndValidateManifest,
  stableStringify,
  writeManifest,
  type CompiledManifest,
} from "../src/manifest.ts";
import { definePumice, resolveViteTaskRunner } from "../src/pumice.ts";
import { main as runManifest } from "../src/vite-task-runner.ts";

const RECORD_ARGS = fileURLToPath(new URL("fixtures/record-args.js", import.meta.url));
const RECORD_SIGNAL = fileURLToPath(new URL("fixtures/record-signal.js", import.meta.url));
const RUNNER = fileURLToPath(new URL("../src/vite-task-runner.ts", import.meta.url));

test("stable serialization ignores object insertion order", () => {
  const left = { z: 1, nested: { b: true, a: "value" } };
  const right = { nested: { a: "value", b: true }, z: 1 };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(manifestHash(stableStringify(left)), manifestHash(stableStringify(right)));
});

test("service plans honor dependency order and reject invalid graphs", () => {
  const plan = normalizePlan({
    services: [
      { name: "api", command: "api", dependsOn: ["db"] },
      { name: "db", command: "db" },
    ],
  });
  assert.deepEqual(
    plan.services.map(({ name }) => name),
    ["db", "api"],
  );
  assert.throws(
    () =>
      normalizePlan({
        services: [
          { name: "one", command: "one", dependsOn: ["two"] },
          { name: "two", command: "two", dependsOn: ["one"] },
        ],
      }),
    /contains a cycle/,
  );
});

test("nested service composition produces a topologically ordered v1 manifest", async () => {
  await using temporary = await temporaryDirectory();
  const pumice = definePumice({
    workspaceRoot: temporary.path,
    cacheDirectory: join(temporary.path, "cache"),
    scope: { type: "worktree", id: "test-scope" },
    ports: ["DATABASE_PORT"],
    services: {
      db: {
        command: "database --port $DATABASE_PORT",
        healthcheck: "database-ready --port $DATABASE_PORT",
      },
    },
  });
  const api = pumice.service("db").service({
    name: "api",
    command: "api --port $API_PORT",
    healthcheck: "api-ready --port $API_PORT",
    ports: ["API_PORT"],
  });

  const manifest = api.manifest({ command: "test --database $DATABASE_PORT" });
  assert.equal(manifest.version, 1);
  assert.deepEqual(
    manifest.services.map(({ name, dependsOn }) => ({ name, dependsOn })),
    [
      { name: "db", dependsOn: [] },
      { name: "api", dependsOn: ["db"] },
    ],
  );
  assert.match(manifest.services[0]!.command, /^database --port \d+$/);
  assert.match(manifest.services[1]!.command, /^api --port \d+$/);
  assert.equal(manifest.services[0]!.env.API_PORT, undefined);
  assert.match(manifest.services[1]!.env.API_PORT!, /^\d+$/);
  assert.match(manifest.command.command, /^test --database \d+$/);
  assert.equal(manifest.services[0]!.healthcheck?.intervalMs, 250);

  const task = api.task({ command: "test", persistent: true });
  assert.equal(task.cache, false);
  assert.equal(task.persistent, true);
  assert.match(task.command, /^node '.+vite-task-runner\.ts' '.+\/[a-f0-9]{64}\.json'$/);
});

test("manifests are immutable, reusable, and validated against their filename", async () => {
  await using temporary = await temporaryDirectory();
  const manifest = exampleManifest(temporary.path, "exit 0");
  const first = writeManifest(temporary.path, manifest);
  const second = writeManifest(temporary.path, manifest);
  assert.equal(first, second);
  assert.equal(basename(first), `${manifestHash(stableStringify(manifest))}.json`);
  assert.deepEqual(readAndValidateManifest(first), manifest);

  const mutation = stableStringify(exampleManifest(temporary.path, "exit 7"));
  await writeFile(first, mutation);
  assert.throws(() => readAndValidateManifest(first), /content hash does not match filename/);
});

test("the runner preserves additional arguments as argv values", async () => {
  await using temporary = await temporaryDirectory();
  const output = join(temporary.path, "arguments.json");
  const command = [process.execPath, RECORD_ARGS, output].map(shellQuote).join(" ");
  const manifestPath = writeManifest(temporary.path, exampleManifest(temporary.path, command));

  const exitCode = await runManifest([
    manifestPath,
    "value with spaces",
    'a"quote',
    "--flag",
    "--",
    "tail",
  ]);

  assert.equal(exitCode, 0);
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), [
    "value with spaces",
    'a"quote',
    "--flag",
    "--",
    "tail",
  ]);
});

test("the runner forwards SIGINT to the command process group", async () => {
  await using temporary = await temporaryDirectory();
  const started = join(temporary.path, "command.started");
  const signal = join(temporary.path, "command.signal");
  const command = [process.execPath, RECORD_SIGNAL, started, signal].map(shellQuote).join(" ");
  const manifestPath = writeManifest(temporary.path, exampleManifest(temporary.path, command));
  const runner = spawn(process.execPath, [RUNNER, manifestPath], { stdio: "ignore" });
  const exited = waitForChild(runner);

  try {
    await waitForFile(started);
    runner.kill("SIGINT");
    const result = await exited;
    assert.equal(result.code, 130);
    assert.equal(await readFile(signal, "utf8"), "SIGINT");
  } finally {
    runner.kill("SIGKILL");
  }
});

test("daemon launch environment removes task-scoped tracing metadata", () => {
  assert.deepEqual(
    daemonEnvironment({
      PATH: "/bin",
      VP_RUN_IPC_NAME: "ipc",
      VP_RUN_NODE_CLIENT_PATH: "client",
      FSPY_PAYLOAD: "trace",
      LD_PRELOAD: "preload",
      DYLD_INSERT_LIBRARIES: "insert",
    }),
    { PATH: "/bin" },
  );
});

test("the Vite Task runner resolves to an absolute package module", () => {
  assert.equal(resolveViteTaskRunner(), RUNNER);
});

function exampleManifest(workspaceRoot: string, command: string): CompiledManifest {
  return {
    version: 1,
    workspaceRoot,
    scope: { type: "worktree", id: `worktree:${workspaceRoot}` },
    services: [],
    command: { command, cwd: workspaceRoot, env: {} },
  };
}

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "pumice-manifest-test-"));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function waitForFile(path: string, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

function waitForChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
