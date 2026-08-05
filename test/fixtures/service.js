import { writeFileSync } from "node:fs";

const [readyPath, pidPath, stoppedPath, readyDelayValue, exitDelayValue] = process.argv.slice(2);
const readyDelay = Number.parseInt(readyDelayValue, 10);
const exitDelay = Number.parseInt(exitDelayValue, 10);

writeFileSync(pidPath, String(process.pid));
setTimeout(() => writeFileSync(readyPath, "ready"), readyDelay).unref();

if (Number.isSafeInteger(exitDelay) && exitDelay >= 0) {
  setTimeout(() => process.exit(23), exitDelay).unref();
}

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  if (stoppedPath !== "-") writeFileSync(stoppedPath, "stopped");
  setTimeout(() => process.exit(0), 40).unref();
});

setInterval(() => {}, 1_000);
