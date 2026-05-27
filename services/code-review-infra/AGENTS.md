# Code Review Infrastructure Guidance

This guidance supplements the repository-level `AGENTS.md` rules for work in `services/code-review-infra/`.

## Ownership Boundary

`src/code-review-orchestrator.ts` contains the `CodeReviewOrchestrator` Durable Object. It owns execution orchestration after Next.js has dispatched a review. Next.js remains responsible for queue and concurrency business decisions before dispatch.

Keep these code-review concerns in `CodeReviewOrchestrator`:

- Review and attempt identity, lifecycle state, status synchronization, and the web status/callback contract.
- Selection and invocation of supported cloud-agent execution paths, including compatibility behavior for legacy SSE execution.
- Review-specific continuation, fresh-session retry or fallback, cancellation, terminal reconciliation, and other review-facing policy decisions.
- Construction and assignment of per-attempt callback targets when coordinating a dispatched review.

Do not duplicate generic cloud-agent session/runtime mechanics in this service. In particular, do not add implementations of durable session state, message admission or queues, wrapper/socket supervision and fencing, sandbox execution primitives, session event replay, or callback delivery/outbox transport owned by `services/cloud-agent-next/`.

## Cloud Agent Seam

- Request narrowly scoped, reusable session/runtime capabilities through cloud-agent APIs and callback contracts; keep review-level decisions and review identity/status state in `CodeReviewOrchestrator`.
- The retained prepare/update/send flow may be used where the cloud-agent-next contract requires it for review continuation, but the review-specific reason for continuation or fresh retry belongs here.
- Cloud-agent services enforce execution permissions, including read-only code-review command policy. Any command-risk matching in this service is review-side observability or compatibility handling, not the canonical runtime guard.

## Worker and Durable Object Safety

- Follow the inherited Worker and Durable Object rules in the root `AGENTS.md`, including avoiding module-scope caching of transport-owning database or SDK clients and using approved per-use helpers.
- Preserve callback authentication and redaction boundaries; never log tokens, credentials, auth headers, cookies, or webhook secrets.
- Keep changes within this service's orchestration role unless a shared cloud-agent capability must be introduced through an explicit contract.

## Targeted Validation

From the repository root, use the narrowest applicable checks:

- `pnpm --dir services/code-review-infra test`
- `pnpm --dir services/code-review-infra typecheck`
- `pnpm --dir services/code-review-infra lint`

Run only the checks relevant to the files changed, and follow the root formatting requirement before committing.
