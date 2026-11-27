/**
 * The code owners of `packages/db/src/migrations/` (contract §5 step 5, R5-M1), pinned by their
 * immutable GitHub user ids, read with `gh api users/<login> -q .id` on 2026-11-27. The logins are
 * for display and for the CODEOWNERS comparison only: a review counts only when its `user.id` is
 * listed here. Changing an owner is one reviewed PR that edits this file and `.github/CODEOWNERS`
 * together; this file sits under `/services/migration-proxy/`, which the same owners own.
 */
export const MIGRATION_CODE_OWNERS: readonly { id: number; login: string }[] = [
  { id: 54751, login: 'eshurakov' },
  { id: 4062236, login: 'iscekic' },
  { id: 12196001, login: 'chrarnoldus' },
  { id: 2350930, login: 'johnnyeric' },
];

/** The CODEOWNERS pattern whose owner set must equal the pinned logins. */
export const MIGRATIONS_CODEOWNERS_PATTERN = '/packages/db/src/migrations/';

export type OwnersCheck = 'ok' | 'owners_mismatch' | 'owners_unreadable';

/**
 * Compares the owners CODEOWNERS gives the migrations folder with the pinned logins. A missing or
 * unreadable file is `owners_unreadable`; a missing line, a team, an email, or any added, removed
 * or renamed login is `owners_mismatch`. GitHub uses the last matching line, so the last line with
 * exactly this pattern is the one compared.
 */
export function checkCodeowners(text: string | null): OwnersCheck {
  if (text === null) return 'owners_unreadable';
  const lines = text
    .split('\n')
    .map(line => line.replace(/#.*$/, '').trim().split(/\s+/))
    .filter(tokens => tokens[0] === MIGRATIONS_CODEOWNERS_PATTERN);
  const owners = lines.at(-1)?.slice(1);
  if (owners === undefined || owners.length === 0) return 'owners_mismatch';
  const named = owners.map(owner => owner.toLowerCase());
  const pinned = MIGRATION_CODE_OWNERS.map(owner => `@${owner.login.toLowerCase()}`);
  const same =
    new Set(named).size === named.length &&
    named.length === pinned.length &&
    named.every(owner => pinned.includes(owner));
  return same ? 'ok' : 'owners_mismatch';
}

export function isPinnedOwner(userId: number): boolean {
  return MIGRATION_CODE_OWNERS.some(owner => owner.id === userId);
}
