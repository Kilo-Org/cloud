/**
 * The policy files this Worker bundles. `src/policy/index.ts` types its imports
 * against this tuple, so a file added here without an import fails typecheck and
 * `test/repo/policy-files.test.ts` fails when the directory and the tuple differ.
 */
export const POLICY_FILES = [
  'o11y.yaml',
  'audit-relay.yaml',
  'bouncer-watch.yaml',
  'notifications.yaml',
  'usage-ingest.yaml',
  'web.yaml',
  'ci-kilocode-release.yaml',
  'ci-kilocode-release-jetbrains.yaml',
  'ci-kilocode-app-key.yaml',
  'ci-kilocode-scan-notify.yaml',
  'ci-kilocode-community.yaml',
  'ci-kilocode-notify.yaml',
  'ci-kilocode-opencode-watch.yaml',
] as const;

export type PolicyFile = (typeof POLICY_FILES)[number];
