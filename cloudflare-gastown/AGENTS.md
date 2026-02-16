# Conventions

## File naming

- Add a suffix matching the module type, e.g. `agents.table.ts`, `gastown.worker.ts`.
- Modules that predominantly export a class should be named after that class, e.g. `AgentIdentity.do.ts` for `AgentIdentityDO`.

## Durable Objects

- Each DO module must export a `get{ClassName}Stub` helper function (e.g. `getRigDOStub`) that centralizes how that DO namespace creates instances. Callers should use this helper instead of accessing the namespace binding directly.
