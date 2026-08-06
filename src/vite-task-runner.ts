#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { constants } from "node:os";
import { startCommand, type RunningCommand } from "./core/command.ts";
import { ServiceGuard } from "./core/service-guard.ts";
import { readAndValidateManifest, type CompiledManifest } from "./manifest.ts";

export async function main(arguments_ = process.argv.slice(2)): Promise<number> {
  const [manifestPath, ...additionalArgs] = arguments_;
  if (!manifestPath) throw new TypeError("Missing Pumice manifest path");
  const manifest = readAndValidateManifest(manifestPath);

  await using guard = await ServiceGuard.connect(manifest.workspaceRoot);
  await guard.run(toDaemonPlan(manifest));
  await using command = startCommand({ ...manifest.command, stdio: "inherit" }, { additionalArgs });
  using _signals = installSignalForwarding(command);
  const outcome = await Promise.race([
    command.exited.then((result) => ({ type: "command" as const, result })),
    guard.failure.then((error) => ({ type: "guard" as const, error })),
  ]);
  if (outcome.type === "guard") {
    await command.terminate("SIGTERM");
    throw outcome.error;
  }
  if (outcome.result.error) throw outcome.result.error;
  return toExitCode(outcome.result.code, outcome.result.signal);
}

function toExitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return 128 + (constants.signals[signal] ?? 0);
  return 1;
}

export function installSignalForwarding(command: RunningCommand): Disposable {
  const onSigint = () => void command.terminate("SIGINT");
  const onSigterm = () => void command.terminate("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    [Symbol.dispose]() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}

function toDaemonPlan(manifest: CompiledManifest) {
  return {
    services: manifest.services.map((service) => ({
      name: service.name,
      command: service.command,
      healthcheck: service.healthcheck?.command,
      healthcheckTimeout: service.healthcheck?.timeoutMs,
      healthcheckInterval: service.healthcheck?.intervalMs,
      cwd: service.cwd,
      env: service.env,
      dependsOn: service.dependsOn,
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      console.error(formatFailure(error));
      process.exitCode = 1;
    },
  );
}

function formatFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
