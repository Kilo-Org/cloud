import 'server-only';

import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

/**
 * The local forge fixtures run on their own GitHub App, whose installation reaches only the
 * four fixture repositories. A work session points a local Kilo stack at that app with
 * `node src/forge-main.ts env` (kilo-workflow), which also writes this allowlist of one
 * installation id. Uninstalling it from that stack deletes the real installation and takes
 * every fixture offline, so a delete of one of these ids is refused before any GitHub call.
 *
 * The list is read on every call: a stack without the variable keeps the production path,
 * and the value is not cached across a test that sets it.
 */
export const FORGE_FIXTURE_INSTALLATION_IDS_ENV = 'GITHUB_FORGE_INSTALLATION_IDS';

/** Raised when a caller would delete an installation that belongs to the local forge fixtures. */
export class GitHubAppInstallationProtectedError extends Error {
  constructor(readonly installationId: string) {
    super(
      `GitHub installation ${installationId} belongs to the local forge fixture app; it cannot be uninstalled from Kilo`
    );
    this.name = 'GitHubAppInstallationProtectedError';
  }
}

/**
 * The protected installations named by the environment, digits only. Anything else in the
 * variable is ignored rather than treated as an id, so a malformed entry cannot protect or
 * expose another installation.
 */
export function forgeFixtureInstallationIds(): readonly string[] {
  return getEnvVariable(FORGE_FIXTURE_INSTALLATION_IDS_ENV)
    .split(',')
    .map(entry => entry.trim())
    .filter(entry => /^\d+$/.test(entry));
}

/** Refuses a delete of an installation in the forge-fixture allowlist. */
export function assertGitHubInstallationDeletable(installationId: string | number): void {
  const id = String(installationId).trim();
  if (forgeFixtureInstallationIds().includes(id)) {
    throw new GitHubAppInstallationProtectedError(id);
  }
}
