// The `ci-wiring` job runs these suites in one `node --test` invocation. The
// list and the command live here so every suite that pins that job reads one
// definition, and their assertions cannot disagree about what the job must
// run. A suite added to, removed from, or reordered in this list belongs in
// the job's step in the same change.
export const wiringSuites = [
  'scripts/stacked-ci.test.mjs',
  'scripts/changed-dependencies.test.mjs',
  'scripts/build-key-inputs.test.mjs',
  'scripts/ttsc-plugin-key.test.mjs',
  'scripts/affected-workspaces.test.mjs',
  'scripts/changed-workspaces.test.mjs',
  'scripts/changes-filter-retry.test.mjs',
  'scripts/typecheck-ci.test.mjs',
  'scripts/deployment-workflows.test.mjs',
  'scripts/main-workflow-failure.test.mjs',
  'scripts/production-deploy-failure.test.mjs',
  'scripts/meta-janitor-approve.test.mjs',
  'scripts/mobile-sbom-workflow.test.mjs',
];

export const wiringCommand = `node --test ${wiringSuites.join(' ')}`;
