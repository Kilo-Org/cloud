# New apps/mobile test file passes CI without ever running — check the vitest project includes

Symptom: a newly added `apps/mobile` test file passes CI without ever executing; `pnpm test` reports no new suite and the suite count does not grow. Green is not proof the file ran.

Cause: `apps/mobile/vitest.config.ts` composes two projects with **enumerated** include globs. `vitest.pure.config.ts` lists specific directories (`src/lib/*.test.ts`, `src/components/**/*.test.ts`, `src/components/pr-review/**/*.test.tsx`, …) and `vitest.mounted.config.ts` matches only `src/**/*.mounted.test.tsx`. A path outside every listed glob — for example a `.test.tsx` under `src/components/<anything-but-pr-review>/` — matches no project and is silently skipped, with no warning.

Fix: before adding a mobile test in a new directory, check both config files and add the narrowest matching include (e.g. `src/components/kiloclaw/**/*.test.tsx` — not `src/components/**/*.test.tsx`, which would double-own `*.mounted.test.tsx` files with the mounted project). Confirm the suite count actually grew in the `pnpm test` output.
