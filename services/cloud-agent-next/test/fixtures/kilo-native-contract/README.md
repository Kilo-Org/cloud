# Kilo native contract fixtures (`v1`)

Versioned wire fixtures for the Cloud-hosted `/kilo` surface that the future
`kilo-cloud` adapter consumes.

`v1` is unreleased and may be corrected in place until it ships.

## Boundary

- **Cloud-observed behavior only.** These files record what Cloud's facade
  returns today. They define no Kilo public route, no provider capability, and no
  version-2 (checkpoint, handoff, environment) shape.
- **Portable schemas stay in Kilo.** Per the feature PRD, public portable schemas
  belong to Kilo-owned modules that generate the SDK. Cloud owns this fixture
  copy so the adapter can be written and reviewed here without importing Kilo
  internals.
- **Test-only.** Nothing in `src/` reads these files. They exist for adapter
  authors and reviewers.

## Contents

- `v1.json` — the versioned contract: routes, SSE frames, error codes, pagination
  headers, delivery limits, and small recorded fixtures.
- Route `query` fields are required selectors. Collection reads and interaction
  replies use `directory=/cloud-agent/sessions/<sessionID>`, not nested session
  paths. `/event` also requires this selector; `/global/event` accepts none.
- `GET /session` accepts only `limit` and `start` and emits no pagination headers.
  `GET /session/{sessionID}/message` accepts `limit` and `before` and emits
  `Link` and `X-Next-Cursor` when another page exists, plus
  `X-Kilo-Omitted-Item-Count`. The message fixture uses `http://worker.test` as
  the request origin because the next link is absolute.

## Drift

`test/unit/kilo-native-contract-fixture.test.ts` fails when the fixture stops
matching Cloud's source: delivery limits are compared to
`NATIVE_DELIVERY_LIMITS`, SSE frame names to the exported constants, and every
error code must appear in `src/kilo-facade/user-kilo-facade.ts`. Every route,
including parameterized paths and HTTP methods, is exercised through the real
facade handler with injectable dependencies. Regression cases reject the old
nested interaction routes and invalid selectors. List bodies are compared to
`projectPublicListedSession`; list and message pagination are checked against
real handler responses.

## Adding a version

Add `v2.json` and a new validator case. Never edit a released version in place:
an adapter pinned to `v1` must keep working.
