# Pumice

Run a task from the current Git worktree without installing Pumice globally.
Pumice reads tasks from `pumice.yaml` or `pumice.yml`.

## pnpx

```sh
pnpx --package=pumice-cli@alpha pum run <task>
```

For example:

```sh
pnpx --package=pumice-cli@alpha pum run dev
pnpx --package=pumice-cli@alpha pum run db:migrate
```

## npx

```sh
npx --package=pumice-cli@alpha -- pum run <task>
```

For example:

```sh
npx --package=pumice-cli@alpha -- pum run dev
npx --package=pumice-cli@alpha -- pum run db:migrate
```
