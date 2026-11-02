import type { McpPackageEcosystem } from './mcp-identity';

// A hint is offered only for a whole version, never for a distribution tag. npm semver separates a
// prerelease with `-`; PEP 440 also allows a marker directly after the release segment.
const NPM_VERSION = /^v?(\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/;
const PYPI_VERSION =
  /^v?(\d+(?:\.\d+)*(?:(?:a|b|rc|post|dev)\d*|[-.][0-9A-Za-z][0-9A-Za-z.-]*)*)$/i;

/**
 * The version to offer as a minimum for a package, or null when the value is not a whole version.
 * A leading `v` is dropped so the caller stores a plain version.
 */
export function packageVersionHint(
  ecosystem: McpPackageEcosystem,
  version: string | null | undefined
): string | null {
  if (version === null || version === undefined) return null;
  const pattern = ecosystem === 'npm' ? NPM_VERSION : PYPI_VERSION;
  const match = pattern.exec(version.trim());
  return match ? match[1] : null;
}
