"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SERVICE_DESCRIPTOR,
  definePumice,
  isPumiceService,
  normalizePumiceTasks,
} = require("./index.js");

test("service descriptors are branded and normalize with their task-map key", () => {
  const pumice = definePumice({ ports: ["DEV_PORT", "DATABASE_PORT"] });
  const descriptor = pumice.service({
    command: "database --port $DATABASE_PORT",
    healthcheck: "database-ready --port $DATABASE_PORT",
  });

  assert.equal(isPumiceService(descriptor), true);
  assert.equal(descriptor.cache, false);
  assert.deepEqual(descriptor[SERVICE_DESCRIPTOR].ports, ["DATABASE_PORT", "DEV_PORT"]);

  const normalized = JSON.parse(JSON.stringify({ db: descriptor }));
  assert.equal(normalized.db.cache, false);
  assert.match(normalized.db.command, /^pumice-internal lease --name 'db' --definition /);

  const encoded = normalized.db.command.split(" --definition ")[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")), {
    command: "database --port $DATABASE_PORT",
    healthcheck: "database-ready --port $DATABASE_PORT",
    ports: ["DATABASE_PORT", "DEV_PORT"],
  });
});

test("normalizePumiceTasks leaves finite Vite tasks untouched", () => {
  const pumice = definePumice();
  const finite = { command: "pnpm test", dependsOn: ["db"] };
  const tasks = normalizePumiceTasks({
    db: pumice.service({ command: "db", healthcheck: "db-ready" }),
    test: finite,
  });

  assert.match(tasks.db.command, /--name 'db'/);
  assert.equal(tasks.test, finite);
});

test("configuration rejects invalid definitions eagerly", () => {
  assert.throws(() => definePumice({ ports: ["BAD-PORT"] }), /valid environment/);
  assert.throws(() => definePumice({ ports: ["PORT", "PORT"] }), /more than once/);
  const pumice = definePumice();
  assert.throws(() => pumice.service({ command: "", healthcheck: "true" }), /non-empty/);
  assert.throws(
    () => pumice.service({ command: "db", healthcheck: "true", healthcheckTimeout: 0 }),
    /positive integer/,
  );
});
