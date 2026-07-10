---
name: local-development
description: Start, reuse, inspect, or browser-test local apps and services in this monorepo. Use for local service status, generated endpoint configuration, worktree ports, fake-user login, restarts, and logs.
---

# Local development

Read `DEVELOPMENT.md` for human setup and service procedures. Read `ENVIRONMENT.md` for the environment-variable inventory. Shared web environment mutations are governed by `apps/web/AGENTS.md`; do not use this skill for that workflow.

## Start or reuse services

Before accessing local app or service endpoints, inspect this worktree's services:

```bash
pnpm dev:status --json
```

Reuse an active session and its reported ports. Do not start a competing stack.
`dev:start` cannot add services to an existing session. If the active session
does not include required services, stop it with `pnpm dev:stop`, then recreate
it with the complete needed group or named-service selection:

```bash
KILO_PORT_OFFSET=auto pnpm dev:start <needed-group-or-services>
```

When no session is active, start only the needed group or named services. If
generated local endpoint configuration is needed first, run the matching
selector, then start that same selection with the same automatic offset:

```bash
KILO_PORT_OFFSET=auto pnpm dev:env <needed-group-or-service>
KILO_PORT_OFFSET=auto pnpm dev:start <needed-group-or-service>
```

After startup or reuse, obtain actual ports from `.dev-port`, `pnpm dev:status --json`, or `dev/logs/manifest.json`. Never assume defaults. Open web at `http://localhost:<reported-port>/`.

## Fake login

Use:

```text
http://localhost:<reported-port>/users/sign_in?fakeUser=<fake-email>&callbackPath=<path>
```

Always set `callbackPath` to destination page. Build `<fake-email>` as `kilo-<username>-<time including seconds>@example.com`, where username comes from home directory. For admin access, email must end in `@admin.example.com`. Wait for account-creation spinner to finish. Open admin panel from top-right account menu.

## Service management

| Command or path | Use |
|---|---|
| `dev/logs/manifest.json` | Static service and port snapshot written by `dev:start`. |
| `pnpm dev:status` | Live service status and ports. |
| `pnpm dev:status --json` | Machine-readable session, offset, service, port, status, and group data. |
| `pnpm dev:restart <service>` | Restarts a running service. |
| `dev/logs/<service>.log` | Service log file. |

Use `tail -f dev/logs/<service>.log` to follow a service log.
