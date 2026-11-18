import type { McpPackageEcosystem } from './mcp-identity';
import { normalizeVersionSpec, resolvePackageVersion } from './version-spec';

// A hint is offered only for a whole version. Each pattern has at most one group of each kind and
// no repeated group, so matching runs in time linear in the input length. A leading `v` is
// dropped, and build metadata is left out of the hint because it does not order versions. npm
// semver separates a prerelease with `-`. PEP 440 puts a prerelease, a post release and a dev
// release after the release segment, in that order, each with an optional separator, and reads a
// bare `-N` as a post release.
const NPM_VERSION =
  /^v?(\d+(?:\.\d+)*(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const PYPI_VERSION =
  /^v?(\d+(?:\.\d+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[-_.]?\d*)?(?:(?:[-_.]?(?:post|rev|r)[-_.]?\d*)|(?:-\d+))?(?:[-_.]?dev[-_.]?\d*)?)(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/i;

/**
 * An allowed-versions hint for a package, or null when the value is not a whole version. The
 * floor is resolved the same way enforcement resolves a reported version, so the advertised
 * version always satisfies its own hint.
 */
export function packageVersionSpecHint(
  ecosystem: McpPackageEcosystem,
  version: string | null | undefined
): string | null {
  if (version === null || version === undefined) return null;
  const pattern = ecosystem === 'npm' ? NPM_VERSION : PYPI_VERSION;
  const match = pattern.exec(version.trim());
  const resolved = match ? resolvePackageVersion(match[1], ecosystem) : null;
  if (resolved === null) return null;
  const spec = `>=${resolved}`;
  return normalizeVersionSpec(spec).ok ? spec : null;
}
