#!/usr/bin/env node

"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const platforms = {
  "darwin-arm64": "pum-darwin-arm64",
  "darwin-x64": "pum-darwin-x64",
  "linux-arm64": "pum-linux-arm64",
  "linux-x64": "pum-linux-x64"
};

const target = `${process.platform}-${process.arch}`;
const binary = platforms[target];

if (!binary) {
  console.error(
    `pum: unsupported platform ${target}; supported platforms are ${Object.keys(platforms).join(", ")}`
  );
  process.exit(1);
}

const result = spawnSync(path.join(__dirname, "..", "bin", binary), process.argv.slice(2), {
  stdio: "inherit"
});

if (result.error) {
  console.error(`pum: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
