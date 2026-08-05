#!/usr/bin/env node

import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { DaemonServer } from "./core/daemon.ts";
import { acquireDaemonLock } from "./core/runtime.ts";

const options = parseArguments(process.argv.slice(2));
await mkdir(dirname(options.lockPath), { recursive: true, mode: 0o700 });
const lock = await acquireDaemonLock(options.lockPath);
if (!lock) process.exit(0);

const daemon = new DaemonServer({ socketPath: options.socketPath, idleTimeout: 250 });
const stop = () => void daemon.close();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

try {
  await daemon.listen();
  await daemon.closed;
} finally {
  await daemon.close();
  await lock.close();
  await rm(options.lockPath, { force: true });
}

function parseArguments(arguments_: string[]): { socketPath: string; lockPath: string } {
  const values = new Map<string, string | undefined>();
  for (let index = 0; index < arguments_.length; index += 2) {
    values.set(arguments_[index]!, arguments_[index + 1]);
  }
  const socketPath = values.get("--socket");
  const lockPath = values.get("--lock");
  if (!socketPath || !lockPath) {
    throw new TypeError("usage: pumice-daemon --socket <path> --lock <path>");
  }
  return { socketPath, lockPath };
}
