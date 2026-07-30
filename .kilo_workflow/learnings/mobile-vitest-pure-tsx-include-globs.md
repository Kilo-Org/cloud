# mobile: a `src/components/agents/*.test.tsx` matches no vitest project — coverage guard fails

Symptom: after adding a component test named `*.test.tsx` under
`apps/mobile/src/components/agents/` (or any `src/components/` subtree outside
`pr-review/`/`kiloclaw/`), `pnpm test` fails in `src/lib/vitest-project-coverage.test.ts` with
"Test files matched by no vitest project include — they never run", listing the new file.

Cause: `apps/mobile/vitest.pure.config.ts` includes `src/components/**/*.test.ts` but
`*.test.tsx` **only** under `src/components/pr-review/**` and `src/components/kiloclaw/**`;
`apps/mobile/vitest.mounted.config.ts` includes only `src/**/*.mounted.test.tsx`. A plain
`.test.tsx` elsewhere is an orphan, and the committed coverage guard (which evaluates both
configs' real include arrays against every test-looking file under `src/`) fails the run
loudly instead of letting the file sit idle.

Fix: name the test `*.test.ts` and follow the `message-bubble.test.ts` direct-call convention
(mock `react-native` with string host components, call the component as a function, walk the
returned element tree — works for hook-free components), or name it `*.mounted.test.tsx` and
use the `src/test/render-with-providers.tsx` harness. Only widen
`vitest.pure.config.ts`'s include list when a whole new `.tsx` test directory is being
introduced deliberately.
