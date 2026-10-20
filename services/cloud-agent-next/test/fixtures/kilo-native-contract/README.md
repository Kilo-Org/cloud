# Kilo native contract fixtures (`v1`)

Versioned wire fixtures for the Cloud-hosted `/kilo` surface that the future
`kilo-cloud` adapter consumes.

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

## Drift

`test/unit/kilo-native-contract-fixture.test.ts` fails when the fixture stops
matching Cloud's source: delivery limits are compared to
`NATIVE_DELIVERY_LIMITS`, SSE frame names to the exported constants, and every
error code must appear in `src/kilo-facade/user-kilo-facade.ts`.

## Adding a version

Add `v2.json` and a new validator case. Never edit a released version in place:
an adapter pinned to `v1` must keep working.
