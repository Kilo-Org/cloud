import { Range, minVersion as semverMinVersion, valid } from 'semver';
import type { McpPackageEcosystem } from './mcp-identity';
import type { Normalized } from './normalized';
import { MAX_SEMVER_LENGTH, VERSION_SPEC_EXAMPLE } from './version-spec-constants';

export { MAX_SEMVER_LENGTH, VERSION_SPEC_EXAMPLE } from './version-spec-constants';

export type VersionCheckResult =
  | 'match'
  | 'version_not_allowed'
  | 'invalid_version'
  | 'invalid_policy';

type ResolvedVersion = {
  version: string;
  /** True when a four-part release was encoded as a prerelease of the next patch. */
  synthetic: boolean;
};

type EncodedRelease = { version: string; extra: string[] };

const PEP440_VERSION =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|alpha|b|beta|c|rc|pre|preview)[-_.]?(\d*))?(?:[-_.]?(post|rev|r)[-_.]?(\d*)|-(\d+))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/i;

const PRE_RELEASE_LABELS: Record<string, string> = {
  a: 'alpha',
  alpha: 'alpha',
  b: 'beta',
  beta: 'beta',
  c: 'rc',
  rc: 'rc',
  pre: 'rc',
  preview: 'rc',
};

/** `1.2.0rc1` is the only loose spelling accepted; it becomes `1.2.0-rc1`. */
const UNHYPHENATED_PRERELEASE = /(\d+\.\d+\.\d+)(?=[A-Za-z])/g;

const INVALID_RANGE_REASON = `Enter a semver range such as ${VERSION_SPEC_EXAMPLE}. Tags like latest aren’t allowed.`;

/**
 * Parses a range strictly. Loose parsing silently drops tokens it does not
 * understand (`>=1.0.0, <2.0.0` becomes `<2.0.0`), and an empty `||`
 * alternative matches every version, so both would widen a policy unnoticed.
 */
function compileVersionRange(
  spec: string,
  options: { includePrerelease?: boolean } = {}
): Normalized<Range> {
  const trimmed = spec.trim();
  if (trimmed.includes(',')) {
    return {
      ok: false,
      reason: 'Separate comparators with spaces, not commas, such as >=1.0.0 <2.0.0.',
    };
  }
  const alternatives = trimmed.split('||');
  if (alternatives.some(alternative => alternative.includes('|'))) {
    return {
      ok: false,
      reason: `Separate alternative ranges with ||, such as ${VERSION_SPEC_EXAMPLE}.`,
    };
  }
  if (alternatives.some(alternative => alternative.trim() === '')) {
    return {
      ok: false,
      reason: `Each || alternative needs a range, such as ${VERSION_SPEC_EXAMPLE}.`,
    };
  }
  let range: Range;
  try {
    range = new Range(trimmed.replace(UNHYPHENATED_PRERELEASE, '$1-'), options);
  } catch {
    return { ok: false, reason: INVALID_RANGE_REASON };
  }
  if ((range.range || '*') === '*' && trimmed !== '*') {
    return {
      ok: false,
      reason: 'That range allows every version. Leave it blank to allow any version.',
    };
  }
  return { ok: true, value: range };
}

/** An allowed-versions range. Blank means any version. */
export function normalizeVersionSpec(input: string | null | undefined): Normalized<string | null> {
  const trimmed = input?.trim() ?? '';
  if (trimmed === '') return { ok: true, value: null };
  if (trimmed.length > MAX_SEMVER_LENGTH) {
    return {
      ok: false,
      reason: `Keep the allowed versions under ${MAX_SEMVER_LENGTH} characters.`,
    };
  }
  const compiled = compileVersionRange(trimmed);
  return compiled.ok ? { ok: true, value: trimmed } : compiled;
}

function numericIdentifier(digits: string | undefined): string {
  return digits === undefined || digits === '' ? '0' : String(Number(digits));
}

/**
 * Semver has three release segments. A further PEP 440 segment such as
 * `1.2.3.4` is encoded as the lowest prerelease of the next patch
 * (`1.2.4-0.4`), which sorts above `1.2.3` and below `1.2.4`. Trailing zero
 * segments are insignificant, so `1.2.3.0` is `1.2.3`.
 */
function encodeRelease(release: string): EncodedRelease | null {
  const parts = release.split('.').map(Number);
  if (parts.some(part => !Number.isSafeInteger(part))) return null;
  while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
  while (parts.length < 3) parts.push(0);
  if (parts.length === 3) return { version: parts.join('.'), extra: [] };
  const [major, minor, patch, ...rest] = parts;
  return { version: `${major}.${minor}.${patch + 1}`, extra: ['0', ...rest.map(String)] };
}

function formatRelease(release: EncodedRelease): string {
  return release.extra.length > 0
    ? `${release.version}-${release.extra.join('.')}`
    : release.version;
}

/**
 * Maps common PEP 440 spellings onto semver so one comparator can enforce both
 * ecosystems. Post releases compare as their release and dev releases as a
 * prerelease. A pre or dev release of a four-part version cannot be ordered
 * after encoding and is rejected.
 */
function pep440ToSemver(input: string): ResolvedVersion | null {
  const match = PEP440_VERSION.exec(input.trim());
  if (!match) return null;
  const [, epoch, releaseText, preLabel, preNumber, postLabel, postNumber, postDash, devNumber] =
    match;
  if (epoch !== undefined) return null;
  const release = encodeRelease(releaseText);
  if (release === null) return null;
  const synthetic = release.extra.length > 0;

  const prerelease: string[] = [];
  if (devNumber !== undefined) {
    // Numeric identifiers sort before alphanumeric ones, which puts a dev
    // release before alpha/beta/rc releases as PEP 440 requires.
    prerelease.push('0', 'dev', numericIdentifier(devNumber));
  }
  if (preLabel !== undefined) {
    prerelease.push(PRE_RELEASE_LABELS[preLabel.toLowerCase()] ?? 'rc');
    prerelease.push(numericIdentifier(preNumber));
  }
  if (synthetic && prerelease.length > 0) return null;
  if ((postLabel !== undefined || postDash !== undefined) && prerelease.length > 0) {
    prerelease.push('post', numericIdentifier(postNumber ?? postDash));
  }

  const identifiers = synthetic ? release.extra : prerelease;
  if (identifiers.length === 0) return { version: release.version, synthetic: false };
  const version = valid(`${release.version}-${identifiers.join('.')}`);
  return version === null ? null : { version, synthetic };
}

function resolveVersion(input: string, ecosystem: McpPackageEcosystem): ResolvedVersion | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  if (ecosystem === 'pypi') {
    const pypi = pep440ToSemver(trimmed);
    if (pypi !== null) return pypi;
  }
  const version = valid(trimmed, { loose: true });
  return version === null ? null : { version, synthetic: false };
}

/**
 * The version a client resolved and is about to run. Loose parsing accepts
 * ecosystem spellings such as `1.2.0rc1`; PyPI also maps PEP 440 post/dev and
 * four-part spellings onto semver.
 */
export function resolvePackageVersion(
  input: string,
  ecosystem: McpPackageEcosystem
): string | null {
  return resolveVersion(input, ecosystem)?.version ?? null;
}

/**
 * Converts a stored pre-range minimum version into an equivalent `>=` range.
 * Used while `min_version` remains readable during the client rollout. The
 * result excludes prereleases, which the pre-range numeric comparison admitted.
 */
export function legacyMinVersionToSpec(input: string | null | undefined): string | null {
  const trimmed = input?.trim() ?? '';
  if (trimmed === '') return null;
  const pypi = pep440ToSemver(trimmed);
  if (pypi !== null) return `>=${pypi.version}`;
  const exact = valid(trimmed, { loose: true });
  if (exact !== null) return `>=${exact}`;
  const prefix = /^v?(\d+(?:\.\d+)*)/.exec(trimmed);
  if (prefix === null) return null;
  const release = encodeRelease(prefix[1]);
  return release === null ? null : `>=${formatRelease(release)}`;
}

/**
 * The lowest version a range admits, kept as a floor that pre-range clients can
 * enforce. A single floor cannot express an upper bound or a gap, so those
 * clients may admit versions the range excludes until they upgrade.
 */
export function minimumVersionForSpec(spec: string | null | undefined): string | null {
  if (!spec) return null;
  const compiled = compileVersionRange(spec);
  if (!compiled.ok) return null;
  return semverMinVersion(compiled.value)?.version ?? null;
}

export type LegacyMinVersion =
  | { kind: 'none' }
  | { kind: 'any' }
  | { kind: 'range'; value: string }
  | { kind: 'invalid' };

/**
 * Classifies a stored pre-range minimum before it is exposed as a range.
 * `0.0.0` (and equivalent spellings) allowed every version, while an
 * unparseable minimum must stay fail-closed as `invalid`.
 */
export function classifyLegacyMinVersion(input: string | null | undefined): LegacyMinVersion {
  const trimmed = input?.trim() ?? '';
  if (trimmed === '') return { kind: 'none' };
  const spec = legacyMinVersionToSpec(trimmed);
  if (spec === null) return { kind: 'invalid' };
  const normalized = normalizeVersionSpec(spec);
  if (normalized.ok) {
    return normalized.value === null ? { kind: 'any' } : { kind: 'range', value: normalized.value };
  }
  let minimum: string | null = null;
  try {
    minimum = semverMinVersion(spec, { loose: true })?.version ?? null;
  } catch {
    minimum = null;
  }
  return minimum === '0.0.0' ? { kind: 'any' } : { kind: 'invalid' };
}

export function isValidVersionSpec(spec: string): boolean {
  return compileVersionRange(spec).ok;
}

/**
 * Checks a resolved version against a stored range. Prereleases are excluded
 * unless the range names a prerelease comparator on the same release tuple,
 * matching standard semver; `>=1.2.0` therefore excludes `2.0.0-beta.3`.
 */
export function checkVersion(
  version: string,
  spec: string,
  ecosystem: McpPackageEcosystem
): VersionCheckResult {
  const compiled = compileVersionRange(spec);
  if (!compiled.ok) return 'invalid_policy';
  const resolved = resolveVersion(version, ecosystem);
  if (resolved === null) return 'invalid_version';
  // An encoded four-part release is a real release, not a prerelease to exclude.
  const range = resolved.synthetic
    ? new Range(compiled.value.range || '*', { includePrerelease: true })
    : compiled.value;
  return range.test(resolved.version) ? 'match' : 'version_not_allowed';
}
