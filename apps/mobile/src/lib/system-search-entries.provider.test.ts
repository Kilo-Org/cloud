/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock settles without await because it resolves immediately */
import { describe, expect, it, vi } from 'vitest';

import {
  inboxPrSearchDocument,
  providerPrSearchDocument,
  recentPrSearchDocument,
} from './system-search-entries';

// `system-search-entries` reuses `providerRefFromRecentPr` from the recents
// module, which opens SecureStore on import. The native module is not
// available under Node, and the builders here never read storage.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

describe('providerPrSearchDocument', () => {
  it('builds a GitLab inbox row through the provider route builder', () => {
    const document = providerPrSearchDocument(
      {
        platform: 'gitlab',
        projectPath: 'group/sub/repo',
        mrIid: 12,
        instanceHint: 'https://gitlab.example.com',
      },
      'Nested MR'
    );

    expect(document.id).toBe(
      '/(app)/pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com'
    );
    expect(document.title).toBe('Nested MR');
    expect(document.description).toBe('group/sub/repo!12');
    expect(document.keywords).toEqual(['group/sub/repo', '12']);
    expect(document.route).toBe(
      'kiloapp://pr-review/gitlab/group/sub/repo/12?instance=https%3A%2F%2Fgitlab.example.com'
    );
  });

  it('builds a Bitbucket inbox row through the provider route builder', () => {
    const document = providerPrSearchDocument(
      { platform: 'bitbucket', workspace: 'acme', repoSlug: 'web', prId: 7 },
      'Bitbucket PR'
    );

    expect(document.id).toBe('/(app)/pr-review/bitbucket/acme/web/7');
    expect(document.title).toBe('Bitbucket PR');
    expect(document.description).toBe('acme/web#7');
    expect(document.keywords).toEqual(['acme/web', '7']);
    expect(document.route).toBe('kiloapp://pr-review/bitbucket/acme/web/7');
  });

  it('keeps the GitHub route for a GitHub ref, like the inbox builder', () => {
    const document = providerPrSearchDocument(
      { platform: 'github', owner: 'octocat', repo: 'hello-world', number: 42 },
      'Hello PR'
    );

    expect(document.id).toBe('/(app)/pr-review/octocat/hello-world/42');
    expect(document).toEqual(
      inboxPrSearchDocument({
        owner: 'octocat',
        repo: 'hello-world',
        number: 42,
        title: 'Hello PR',
      })
    );
  });

  it('emits the same entry as the recents builder for the same provider entry', () => {
    // The collector dedupes by id: the provider inbox row and the stored
    // recent must land on one entry, or the index carries the same PR twice.
    // The fingerprints may differ by the source scope the row was enumerated
    // from — the collector keeps the first occurrence, so one entry survives.
    const ref = {
      platform: 'gitlab' as const,
      projectPath: 'group/repo',
      mrIid: 3,
      instanceHint: 'https://gitl.ab',
    };
    const fromInbox = providerPrSearchDocument(ref, 'Same MR', 'pullRequests:gitlab:org-1');
    const fromRecents = recentPrSearchDocument({
      owner: 'group',
      repo: 'repo',
      number: 3,
      title: 'Same MR',
      platform: 'gitlab',
      instanceHint: 'https://gitl.ab',
    });

    expect(fromInbox.id).toBe(fromRecents.id);
    // The inbox row keeps the organization scope that enumerated it; the
    // recents entry is account-level, so its source is the recents list's own
    // per-provider scope, which no inbox query enumerates.
    expect(fingerprintSourceOf(fromInbox.fingerprint)).toBe('pullRequests:gitlab:org-1');
    expect(fingerprintSourceOf(fromRecents.fingerprint)).toBe('pullRequests:gitlab:recents');
  });
});

function fingerprintSourceOf(fingerprint: string): string | undefined {
  return (JSON.parse(fingerprint) as { source?: string }).source;
}
