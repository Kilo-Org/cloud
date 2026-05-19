# dolthub

Low-level DoltHub HTTP client. Planned files:

- `api.ts` — shared fetch wrapper, auth, error mapping.
- `read.ts` — read-only queries (`/api/v1alpha1/.../query`).
- `write.ts` — write queries via the operation endpoint.
- `branches.ts` — branch CRUD.
- `pulls.ts` — pull request lifecycle.
- `operation.ts` — long-running operation polling.

Each file is added by a follow-up task.
