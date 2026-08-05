import { writeFileSync } from "node:fs";

const [startedPath, stoppedPath, stopDelayValue] = process.argv.slice(2);
const stopDelay = Number.parseInt(stopDelayValue, 10);

writeFileSync(startedPath, String(process.pid));
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => {
    writeFileSync(stoppedPath, "stopped");
    process.exit(0);
  }, stopDelay).unref();
});

setInterval(() => {}, 1_000);
