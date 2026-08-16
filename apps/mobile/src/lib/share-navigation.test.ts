import { afterEach, describe, expect, it, vi } from 'vitest';

import { SHARE_PAYLOAD_MAX_ENTRIES } from './share-payload';
import {
  __resetPendingShareNavigationForTests,
  appendShareParams,
  isShareNavigationTargetFocused,
  navigationContainsShareGate,
  parseShareHrefParams,
  setPendingShareNavigation,
  shareDeliveryShareId,
  takePendingShareNavigation,
} from './share-navigation';

// share-navigation imports SHARE_PAYLOAD_MAX_ENTRIES from share-payload, which
// pulls expo modules that transitively load react-native Flow sources.
vi.mock('expo-crypto', () => ({
  randomUUID: () => 'id-test',
}));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  copyAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
  deleteAsync: vi.fn(async () => {
    await Promise.resolve();
  }),
}));

afterEach(() => {
  __resetPendingShareNavigationForTests();
});

describe('share-navigation', () => {
  it('set then take returns the entry', () => {
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' });
    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/agent-chat/new?shareId=a',
      shareId: 'a',
    });
  });

  it('second take returns null', () => {
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' });
    takePendingShareNavigation();
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('enqueues FIFO: take returns oldest first', () => {
    setPendingShareNavigation({ href: '/first', shareId: 'first' });
    setPendingShareNavigation({ href: '/second', shareId: 'second' });
    expect(takePendingShareNavigation()).toEqual({ href: '/first', shareId: 'first' });
    expect(takePendingShareNavigation()).toEqual({ href: '/second', shareId: 'second' });
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('drops oldest when enqueue would exceed SHARE_PAYLOAD_MAX_ENTRIES', () => {
    for (let i = 0; i < SHARE_PAYLOAD_MAX_ENTRIES + 2; i += 1) {
      setPendingShareNavigation({ href: `/${i}`, shareId: `id-${i}` });
    }
    const taken: string[] = [];
    let next = takePendingShareNavigation();
    while (next) {
      if (shareDeliveryShareId(next)) {
        taken.push(next.shareId);
      }
      next = takePendingShareNavigation();
    }
    expect(taken).toHaveLength(SHARE_PAYLOAD_MAX_ENTRIES);
    expect(taken.at(0)).toBe('id-2');
    expect(taken.at(-1)).toBe(`id-${SHARE_PAYLOAD_MAX_ENTRIES + 1}`);
  });

  it('take with nothing pending returns null', () => {
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('reset clears the full queue', () => {
    setPendingShareNavigation({ href: '/a', shareId: 'a' });
    setPendingShareNavigation({ href: '/b', shareId: 'b' });
    __resetPendingShareNavigationForTests();
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('enqueues and returns a null-shareId navigation unchanged', () => {
    setPendingShareNavigation({
      href: '/(app)/pr-review/octocat/hello-world/42',
      shareId: null,
    });
    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/pr-review/octocat/hello-world/42',
      shareId: null,
    });
  });
});

describe('shareDeliveryShareId', () => {
  it('is false when shareId is null', () => {
    expect(
      shareDeliveryShareId({ href: '/(app)/pr-review/octocat/hello-world/42', shareId: null })
    ).toBe(false);
  });

  it('is true when shareId is a string', () => {
    expect(shareDeliveryShareId({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' })).toBe(
      true
    );
  });
});

describe('parseShareHrefParams', () => {
  it('extracts organizationId from a full new-session href', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/new?shareId=abc&organizationId=org_1')).toEqual({
      organizationId: 'org_1',
    });
  });

  it('returns undefined organizationId when absent', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/new?shareId=abc')).toEqual({
      organizationId: undefined,
    });
  });

  it('returns undefined organizationId when query is absent', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/new')).toEqual({
      organizationId: undefined,
    });
  });

  it('extracts organizationId from an existing-session href the same way', () => {
    expect(parseShareHrefParams('/(app)/agent-chat/ses_1?shareId=x&organizationId=org_2')).toEqual({
      organizationId: 'org_2',
    });
  });
});

describe('isShareNavigationTargetFocused', () => {
  it('matches same-session focused via concrete pathname', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=x', '/agent-chat/ses_1')
    ).toBe(true);
  });

  it('is false when the session id differs', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=x', '/agent-chat/ses_2')
    ).toBe(false);
  });

  it('matches focused agent-chat/new', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/new?shareId=x', '/agent-chat/new')
    ).toBe(true);
  });

  it('is false when on a different screen', () => {
    expect(isShareNavigationTargetFocused('/(app)/agent-chat/new?shareId=x', '/')).toBe(false);
  });

  it('ignores query string on the href', () => {
    expect(
      isShareNavigationTargetFocused(
        '/(app)/agent-chat/ses_1?shareId=stale&organizationId=o',
        '/agent-chat/ses_1'
      )
    ).toBe(true);
  });

  it('ignores group segments in the href', () => {
    expect(isShareNavigationTargetFocused('/(app)/agent-chat/ses_1', '/agent-chat/ses_1')).toBe(
      true
    );
  });

  it('is unaffected by a stale shareId already on the current URL path comparison', () => {
    // Pathname from usePathname has no query; predicate must not consult params.
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=new', '/agent-chat/ses_1')
    ).toBe(true);
  });
});

describe('navigationContainsShareGate', () => {
  it('finds share-gate nested in routes', () => {
    expect(
      navigationContainsShareGate({
        routes: [{ name: '(app)', state: { routes: [{ name: 'share-gate' }] } }],
      })
    ).toBe(true);
  });

  it('is false when the gate is absent', () => {
    expect(
      navigationContainsShareGate({
        routes: [{ name: '(app)', state: { routes: [{ name: '(tabs)' }] } }],
      })
    ).toBe(false);
  });
});

describe('appendShareParams', () => {
  it('appends shareId to a path with no existing query', () => {
    expect(appendShareParams('/(app)/agent-chat/new', 'abc123')).toBe(
      '/(app)/agent-chat/new?shareId=abc123'
    );
  });

  it('appends shareId to a path with an existing query', () => {
    expect(appendShareParams('/(app)/agent-chat/new?organizationId=org_1', 'abc123')).toBe(
      '/(app)/agent-chat/new?organizationId=org_1&shareId=abc123'
    );
  });

  it('appends autoSend=1 when autoSend is true', () => {
    expect(appendShareParams('/(app)/agent-chat/ses_1', 'abc123', { autoSend: true })).toBe(
      '/(app)/agent-chat/ses_1?shareId=abc123&autoSend=1'
    );
  });

  it('does not append autoSend when autoSend is false', () => {
    expect(appendShareParams('/(app)/agent-chat/ses_1', 'abc123', { autoSend: false })).toBe(
      '/(app)/agent-chat/ses_1?shareId=abc123'
    );
  });

  it('URL-encodes the shareId', () => {
    const encoded = appendShareParams('/(app)/agent-chat/new', 'id with spaces');
    expect(encoded).toBe('/(app)/agent-chat/new?shareId=id%20with%20spaces');
  });
});
