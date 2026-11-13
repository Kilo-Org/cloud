import { type RepositoryModelOverrideInput } from '@kilocode/app-shared/code-review';

import { type ConfigPatch } from '@/lib/code-reviewer-config';

/**
 * The handlers that edit the per-repository model overrides (the web form's
 * Advanced section). The list is persisted whole, so each edit replaces the
 * stored entry for its repository and leaves every other repository's entry
 * alone.
 */
export function repositoryModelOverrideHandlers(
  overrides: RepositoryModelOverrideInput[],
  save: (patch: ConfigPatch) => void
) {
  const set = (override: RepositoryModelOverrideInput) => {
    save({
      repositoryModelOverrides: [
        ...overrides.filter(entry => entry.repositoryId !== override.repositoryId),
        override,
      ],
    });
  };
  const remove = (repositoryId: number | string) => {
    save({
      repositoryModelOverrides: overrides.filter(entry => entry.repositoryId !== repositoryId),
    });
  };
  return { set, remove };
}
