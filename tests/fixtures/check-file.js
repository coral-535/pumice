import { accessSync } from "node:fs";

try {
  accessSync(process.argv[2]);
} catch {
  process.exitCode = 1;
}
