import { writeFileSync } from "node:fs";

const [output, ...arguments_] = process.argv.slice(2);
writeFileSync(output, JSON.stringify(arguments_));
