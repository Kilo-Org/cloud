import { canManageOrganizationBilling, type OrganizationRole } from '../organizations/roles';

export const PERSONAL_SECURITY_SCOPE = 'personal';

export function isPersonalSecurityScope(scope: string): boolean {
  return scope === PERSONAL_SECURITY_SCOPE;
}

export function canManageSecurityAgent(scope: string, role: OrganizationRole | undefined): boolean {
  return isPersonalSecurityScope(scope) || canManageOrganizationBilling(role);
}

export function getSecurityAgentAuditUrl(webBaseUrl: string, scope: string): string {
  const base = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  return isPersonalSecurityScope(scope)
    ? `${base}/security-agent/audit-report`
    : `${base}/organizations/${encodeURIComponent(scope)}/security-agent/audit-report`;
}

// `T` stands in for the platform-specific security-agent config shape
// (web's DB-backed config / mobile's tRPC-derived config) — both are plain
// records of scalars and arrays, which is all this comparison needs.
export function isSecurityConfigPatchDirty<T extends Record<string, unknown>>(
  config: Partial<T>,
  patch: Partial<T>
): boolean {
  return Object.entries(patch).some(([key, next]) => {
    const current = config[key as keyof T];
    if (Array.isArray(next) && Array.isArray(current)) {
      return next.length !== current.length || next.some(value => !current.includes(value));
    }
    return !Object.is(next, current);
  });
}

type SecurityRepository = { id: number };

type SecurityRepositoryScopeConfig = {
  repositorySelectionMode: 'all' | 'selected';
  selectedRepositoryIds: readonly number[];
};

export function getSecurityRepositoriesInScope<T extends SecurityRepository>(
  repositories: readonly T[],
  config: SecurityRepositoryScopeConfig | undefined
): T[] {
  if (!config || config.repositorySelectionMode === 'all') {
    return [...repositories];
  }
  const selectedIds = new Set(config.selectedRepositoryIds);
  return repositories.filter(repository => selectedIds.has(repository.id));
}

/**
 * Pure classification of a settings screen's local edits against the loaded
 * config. `dirty-invalid` covers edits that fail screen-specific validation
 * (e.g. an empty repository selection, an out-of-range SLA day count) — the
 * screen supplies `valid` since only it knows its own validation rule.
 */
type SettingsDirtyState = 'clean' | 'dirty-valid' | 'dirty-invalid';

const MIN_SLA_DAYS = 1;
const MAX_SLA_DAYS = 365;

/**
 * Parses a raw numeric input string into a whole-day count, or `NaN` if it
 * isn't one — any day count validated as 1-365 whole days goes through here.
 *
 * The raw input carries the keypad's own digits, and a keypad follows its
 * script, not the ASCII one: an Arabic-Indic keyboard types `٣٢` for 32.
 * Every decimal digit (`\p{Nd}`) set is ten consecutive code points in
 * ascending order and adjacent sets share no separator, so a digit's value is
 * its offset from the start of its run modulo ten — the same fold the mobile
 * app's `foldDecimalDigits` (apps/mobile/src/lib/format.ts) applies. The
 * mobile settings screens read their `TextInput`s through
 * `parseLocalizedNumber`, which folds inside it, and keep this parser for the
 * domain rule the save path enforces (tests pin both).
 */
export function parseDayCount(raw: string): number {
  const folded = raw.trim().replace(/\p{Nd}/gu, digit => {
    const codePoint = digit.codePointAt(0) ?? 0;
    let start = codePoint;
    while (/\p{Nd}/u.test(String.fromCodePoint(start - 1))) {
      start -= 1;
    }
    return String((codePoint - start) % 10);
  });
  return /^\d+$/.test(folded) ? Number(folded) : Number.NaN;
}

export function isValidDayCount(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_SLA_DAYS && value <= MAX_SLA_DAYS;
}

export function getSettingsDirtyState<T extends Record<string, unknown>>(
  config: Partial<T>,
  patch: Partial<T>,
  valid: boolean
): SettingsDirtyState {
  if (!isSecurityConfigPatchDirty(config, patch)) {
    return 'clean';
  }
  return valid ? 'dirty-valid' : 'dirty-invalid';
}

type SettingsBackGuardOption = 'save' | 'discard' | 'keep-editing';

/**
 * Which buttons a back-navigation confirmation alert should offer. A clean
 * screen returns no options — callers should let navigation proceed with no
 * alert at all. A dirty-invalid screen omits "save": there is nothing valid
 * to persist, so the user can only discard or keep editing.
 */
export function getSettingsBackGuardOptions(
  dirtyState: SettingsDirtyState
): SettingsBackGuardOption[] {
  if (dirtyState === 'clean') {
    return [];
  }
  if (dirtyState === 'dirty-invalid') {
    return ['discard', 'keep-editing'];
  }
  return ['save', 'discard', 'keep-editing'];
}
