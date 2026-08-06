import { writeFileSync } from "node:fs";

const [startedPath, signalPath] = process.argv.slice(2);
writeFileSync(startedPath, String(process.pid));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    writeFileSync(signalPath, signal);
    process.exit(0);
  });
}

setInterval(() => {}, 1_000);
