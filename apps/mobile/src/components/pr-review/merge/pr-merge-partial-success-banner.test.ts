import { describe, expect, it, vi } from 'vitest';

import { PrMergePartialSuccessBanner as banner } from './pr-merge-partial-success-banner';

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

const REASON = 'Reference does not exist';

describe('PrMergePartialSuccessBanner', () => {
  it('renders the merge-success headline and the branch-delete failure reason without a live region', () => {
    const element = banner({ reason: REASON });
    const serialized = JSON.stringify(element);

    expect(serialized).toContain('Merged');
    expect(serialized).toContain(`Couldn't delete the branch: ${REASON}`);
    // The banner has no live region: the merge hook owns the partial
    // announcement, so a second announcement channel would double-speak.
    expect(serialized).not.toContain('polite');
  });

  it('contains NO Button or Pressable (no destructive CTA — there is nothing to retry or undo)', () => {
    const element = banner({ reason: REASON });
    const serialized = JSON.stringify(element);

    expect(serialized).not.toContain('Button');
    expect(serialized).not.toContain('Pressable');
  });
});
