import { describe, expect, it } from 'vitest';

import {
  bitbucketRowsUnlisted,
  isStoredRepoSelectionGone,
  type NewSessionRepository,
  type RepositoryGroup,
  type RepositoryPlatform,
  type RepositoryProviderStatus,
} from './new-session-repository-state';

function group(
  key: RepositoryPlatform,
  status: RepositoryProviderStatus,
  extra: Pick<RepositoryGroup, 'notice' | 'rowsUnlisted'> = {}
): RepositoryGroup {
  return { key, status, repositories: [], ...extra };
}

const stored: NewSessionRepository = {
  platform: 'github',
  fullName: 'drain-team/kilo-app',
  isPrivate: true,
};
const others: NewSessionRepository[] = [
  { platform: 'github', fullName: 'drain-team/kilo-backend', isPrivate: true },
  { platform: 'gitlab', fullName: 'drain-team/kilo-app', isPrivate: true },
];

const answers = [group('github', 'repos'), group('gitlab', 'repos'), group('bitbucket', 'connect')];

describe('isStoredRepoSelectionGone', () => {
  it('keeps a selection the provider list contains', () => {
    expect(
      isStoredRepoSelectionGone({
        groups: answers,
        repositories: [stored, ...others],
        selectedRepo: 'github:drain-team/kilo-app',
      })
    ).toBe(false);
  });

  it('drops a selection its own provider no longer lists', () => {
    // A same-named GitLab row is a different repository, not a match.
    expect(
      isStoredRepoSelectionGone({
        groups: answers,
        repositories: others,
        selectedRepo: 'github:drain-team/kilo-app',
      })
    ).toBe(true);
    // A provider that answered with an empty list is an answer too.
    expect(
      isStoredRepoSelectionGone({
        groups: [group('github', 'connected-empty')],
        repositories: [],
        selectedRepo: 'github:drain-team/kilo-app',
      })
    ).toBe(true);
  });

  it('keeps the selection while its own provider may still be missing rows', () => {
    for (const status of ['loading', 'error', 'unavailable'] as const) {
      expect(
        isStoredRepoSelectionGone({
          groups: [group('github', status), group('gitlab', 'repos')],
          repositories: others,
          selectedRepo: 'github:drain-team/kilo-app',
        }),
        status
      ).toBe(false);
    }
    expect(
      isStoredRepoSelectionGone({
        groups: [group('github', 'repos', { notice: 'partial' }), group('gitlab', 'repos')],
        repositories: others,
        selectedRepo: 'github:drain-team/kilo-app',
      })
    ).toBe(false);
  });

  it('does not let another provider decide about the selection', () => {
    // GitHub answered; GitLab is still failing. The GitHub selection is judged
    // by GitHub alone.
    expect(
      isStoredRepoSelectionGone({
        groups: [group('github', 'repos'), group('gitlab', 'error')],
        repositories: others,
        selectedRepo: 'github:drain-team/kilo-app',
      })
    ).toBe(true);
  });

  it('keeps a selection while its provider left rows unlisted, and drops it when it answered', () => {
    // A Bitbucket workspace that needs selecting or new credentials reports the
    // same status as "not connected" but keeps its repositories behind the fix.
    expect(
      isStoredRepoSelectionGone({
        groups: [group('bitbucket', 'connect', { rowsUnlisted: true })],
        repositories: [],
        selectedRepo: 'bitbucket:acme/widgets',
      })
    ).toBe(false);
    // A provider that really has nothing connected has no rows to offer.
    expect(
      isStoredRepoSelectionGone({
        groups: [group('bitbucket', 'connect')],
        repositories: [],
        selectedRepo: 'bitbucket:acme/widgets',
      })
    ).toBe(true);
    expect(
      isStoredRepoSelectionGone({
        groups: [group('github', 'connect')],
        repositories: [],
        selectedRepo: 'github:drain-team/kilo-app',
      })
    ).toBe(true);
  });

  it('drops a selection whose provider is not offered in this scope', () => {
    // Bitbucket is organization-only: a personal scope cannot list it.
    expect(
      isStoredRepoSelectionGone({
        groups: [],
        repositories: [],
        selectedRepo: 'bitbucket:acme/widgets',
      })
    ).toBe(true);
  });

  it('ignores an empty or unqualified key', () => {
    expect(isStoredRepoSelectionGone({ groups: answers, repositories: [], selectedRepo: '' })).toBe(
      false
    );
    expect(
      isStoredRepoSelectionGone({ groups: answers, repositories: [], selectedRepo: 'drain-team/x' })
    ).toBe(false);
  });
});

describe('bitbucketRowsUnlisted', () => {
  it('knows which Bitbucket answers leave the repositories unlisted', () => {
    for (const status of [
      'workspace_selection_required',
      'reconnect_required',
      'insufficient_permissions',
    ]) {
      expect(bitbucketRowsUnlisted(status), status).toBe(true);
    }
    // Nothing connected means nothing to list.
    expect(bitbucketRowsUnlisted('not_connected')).toBe(false);
    expect(bitbucketRowsUnlisted('available')).toBe(false);
    expect(bitbucketRowsUnlisted(undefined)).toBe(false);
  });
});
