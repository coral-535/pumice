import { writeFileSync } from "node:fs";

const [startedPath, delayValue, codeValue] = process.argv.slice(2);
writeFileSync(startedPath, "started");
setTimeout(() => process.exit(Number.parseInt(codeValue, 10)), Number.parseInt(delayValue, 10));
