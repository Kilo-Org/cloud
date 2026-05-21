import { describe, it, expect } from '@jest/globals';
import { buildWastelandItemHref, readWastelandBeadOrigin } from './wasteland-bead-origin';

describe('readWastelandBeadOrigin', () => {
  it('parses a well-formed origin', () => {
    const origin = readWastelandBeadOrigin({
      wasteland: {
        kind: 'wanted-item-claim',
        wasteland_id: 'w-1',
        item_id: 'i-1',
        pull_id: null,
        source_url: 'https://example.com/pulls/1',
      },
    });
    expect(origin?.kind).toBe('wanted-item-claim');
    expect(origin?.wasteland_id).toBe('w-1');
    expect(origin?.item_id).toBe('i-1');
  });

  it('returns null for missing or malformed metadata', () => {
    expect(readWastelandBeadOrigin(null)).toBeNull();
    expect(readWastelandBeadOrigin({})).toBeNull();
    expect(readWastelandBeadOrigin({ wasteland: {} })).toBeNull();
    expect(readWastelandBeadOrigin({ wasteland: { kind: 'unknown' } })).toBeNull();
  });
});

describe('buildWastelandItemHref', () => {
  const origin = { wasteland_id: 'w-abc', item_id: 'item 7/x' };

  it('builds a personal-scope href via the by-id redirect when pathname is not org-scoped', () => {
    expect(buildWastelandItemHref(origin, '/gastown/town-1')).toBe(
      '/wasteland/by-id/w-abc/wanted?itemId=item%207%2Fx'
    );
  });

  it('builds an org-scoped href when pathname is org-scoped', () => {
    expect(buildWastelandItemHref(origin, '/organizations/org-42/gastown/town-1')).toBe(
      '/organizations/org-42/wasteland/w-abc/wanted?itemId=item%207%2Fx'
    );
  });

  it('falls back to the personal by-id redirect when pathname is null', () => {
    expect(buildWastelandItemHref(origin, null)).toBe(
      '/wasteland/by-id/w-abc/wanted?itemId=item%207%2Fx'
    );
  });
});
