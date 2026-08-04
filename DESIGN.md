# Pumice + Vite Task Architecture

## Ownership boundary

Vite Task owns task names, graph expansion, finite commands, scheduling,
caching, and cancellation. Pumice owns only long-running service resources:

- one coordinator daemon per canonical Git worktree;
- named random ports for that daemon namespace;
- one slot and at most one active generation per service name;
- command-based readiness checks;
- socket-lifetime leases; and
- guarded process-group termination.

There is deliberately no Pumice task graph.

## Descriptor normalization

`definePumice({ ports })` creates a descriptor factory. A service descriptor is
branded with `Symbol.for('pumice.service')` and contains an immutable service
definition. The surrounding Vite Task map supplies its name:

```text
tasks.db = pumice.service(definition)
     │
     └─ normalize as service "db"
          └─ pumice-internal lease --name db --definition <base64url-json>
```

The command is never cached. Readiness is reported as a single line:

```text
PUMICE_READY {"type":"ready","service":"db","generation":41,
              "environment":{"DATABASE_PORT":"43127"}}
```

The lease holder remains connected after this line. Its lifetime is the lease.

## Acquisition and generation state

```text
Absent
  └─ ACQUIRE → Starting(db-41)
                  ├─ healthcheck succeeds → Ready(db-41)
                  ├─ process exits        → Failed(db-41) → Absent
                  └─ final lease closes   → Stopping(db-41) → Absent
```

A dead generation is never silently replaced for existing lease holders. A
later acquisition may create `db-42`, which is a distinct generation.

Concurrent callers with the same definition hash attach to the same slot and
generation. A caller with a different hash is rejected while that name is
active. A stopping generation retains the slot until its entire process group
has exited.

## Processes

- **Vite Task host:** owns a run and all finite task processes.
- **Lease holder:** one foreground Pumice client process per service dependency.
- **Worktree daemon:** owns ports, slots, generations, readiness, and lease counts.
- **Service guard:** one supervisor per generation; owns the service process group.
- **Healthcheck guard:** short-lived supervisor for each command check attempt.

The daemon and each guard share a private kernel pipe. Unexpected daemon death
closes the pipe, causing every guard to kill its complete process group. User
commands never inherit daemon lock descriptors.

## Locks and runtime identity

Runtime paths are derived from a hash of the canonical worktree path and live
under a private user runtime directory. A startup flock serializes daemon
creation. A non-blocking lifetime flock prevents competing coordinators for
the same worktree. The Unix socket is user-only.

IPC is versioned. An incompatible client cannot replace or disturb an active
daemon; it must wait until the worktree runtime becomes idle.

## Failure behavior

- Lease-holder EOF releases exactly one lease.
- Final lease release stops that generation.
- Unexpected service exit closes the generation failure channel and fails all
  of its lease holders.
- Unexpected daemon exit disconnects lease holders and causes guards to kill
  service groups.
- No automatic restart is performed.

Snapshot/event state streaming and buffered log attachment remain future work.
