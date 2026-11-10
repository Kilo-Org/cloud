# SCIM dispatcher seam fixtures

The `scim-sync` Worker and this monorepo's Next.js app deploy independently and
talk over the internal directory-sync routes. These two files pin that seam as
data, so each half can be tested against the bytes the other actually produces
rather than against a fake of it.

| File | What it is | Who reads it |
|---|---|---|
| `workos-directory-events.json` | A recorded range of the **real** WorkOS Events API stream, in its raw snake_case wire format | The Worker's producer test serves it to the real `@workos-inc/node` SDK |
| `dispatcher-calls.json` | The ordered `{ method, path, body }` the **real** dispatcher emits for each of those events | The producer test asserts it; the app's consumer test replays it |

Both are reached through `@kilocode/scim-contracts/fixtures`, beside the schemas
the two sides already share, because neither side owns them.

## The two tests

- **Producer** — `services/scim-sync/test/integration/dispatcher-contract.test.ts`
  drives the real Durable Object over every recorded event, in workerd, with the
  app origin stubbed so each route answers its contract's 200. It asserts the
  resulting call list equals `dispatcher-calls.json`, and prints the new
  recording on failure.
- **Consumer** — `apps/web/src/app/api/internal/scim/dispatcher-contract-replay.test.ts`
  replays those calls against the real route handlers: real
  `authorizeInternalApiRequest`, real Zod parsing, real
  `@/lib/scim/directory-sync`, real Postgres. Deliberately **no**
  `jest.mock('@/lib/scim/directory-sync')`.

What the consumer test exists to catch is a **400**. The request schemas are
`z.strictObject`, so a renamed or dropped field is a 400 — and the Worker
classifies a 400 as `unavailable` and retries it indefinitely, holding its
cursor silently instead of failing loudly. That is the drift this file makes
visible in review.

## `workos-directory-events.json` is real, and scrubbed

Ten events in stream order, `rangeStart` through `rangeEnd`, captured from a
live Okta SCIM directory. Untouched except that the five personal email
local-parts were replaced with synthetic ones; names were already synthetic and
`raw_attributes`/`custom_attributes` are empty.

**The email domains are load-bearing.** The directory captures the Okta tenant
hostname `integrator-6483000.okta.com` as its `sso_domain`, while it delivers
users at `gmail.com` and `anaconda.com`. So the app refuses every user bind with
a terminal 409 `domain_not_captured`, and the Worker parks those events. That
refusal is correct behaviour and is the single most valuable thing this capture
holds: it is a real-world configuration no hand-written test produced. Do not
"fix" it into a passing provisioning flow by changing a domain.

The end state the consumer test asserts, which matches a measured run against
real local Postgres: 1 parent organization (`z-corp`, carrying that
`sso_domain`) plus 2 directory-bound children (`kilo-admins`, `kilo-users`),
**zero** directory users, **zero** memberships.

## Coverage split — what is here and what is not

The recorded range covers the **provisioning half with real payloads**:

| Event type | Occurrences in the range |
|---|---|
| `dsync.activated` | 1 |
| `dsync.user.created` | 3 |
| `dsync.group.created` | 2 |
| `dsync.group.updated` | 2 |
| `dsync.group.user_added` | 2 |

The other five `dsync.*` types the dispatcher handles have **never occurred** in
the recorded directory, so these fixtures say nothing about them. They stay
covered by the stubbed suite in
`services/scim-sync/test/integration/scim-sync-do.test.ts`, which drives
hand-written wire payloads through the same real SDK:

- deprovisioning — `dsync.user.deleted`, the `inactive` `dsync.user.updated`,
  `dsync.group.user_removed`;
- `dsync.deleted` and `dsync.group.deleted`;
- the response-class behaviour the recorded range cannot provoke — terminal
  versus retryable 409 classification, deploy-skew 400, redirects, network
  failures, the no-call terminal payloads (a directory user with a null `email`,
  a `dsync.activated` with no `organizationId`), and the drain budget.

That gap is stated here rather than implied, because a reader could otherwise
take "recorded from the real stream" to mean "covers everything".

## When a test fails

`dispatcher-calls.json` is **generated from the dispatcher's real output**, so a
producer failure means the dispatcher's mapping or body construction changed.
That is a signal, not a chore:

1. Read the recording the producer test printed and decide whether the change is
   intended.
2. Confirm the **app accepts the new shape** — run the consumer test against the
   updated file. The request schemas are strict and the two halves deploy
   independently, so a field the Worker starts sending must already be accepted
   (optional) by a deployed app, or every event 400s and the cursor stalls.
3. Only then commit the new recording.

Never blindly re-record: re-recording without step 2 converts a caught
deploy-skew bug into a committed one.

`workos-directory-events.json` is a capture and is not regenerated by any test.
Extending the range means capturing more of the real stream; adding a
hand-written event here would reintroduce exactly the fake this seam pin
removes — the stubbed suite is where synthetic payloads belong.
