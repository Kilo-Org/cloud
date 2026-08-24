/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as image-viewer-modal.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrMergePartialSuccessBanner } from './pr-merge-partial-success-banner';

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));

const REASON = 'Reference does not exist';

function render(reason: string): string {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrMergePartialSuccessBanner, { reason }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('PrMergePartialSuccessBanner renderer was not created');
  }
  const serialized = JSON.stringify(renderer.toJSON());
  renderer.unmount();
  return serialized;
}

describe('PrMergePartialSuccessBanner', () => {
  it('renders the merge-success headline and the branch-delete failure reason without a live region', () => {
    const serialized = render(REASON);

    expect(serialized).toContain('Merged');
    expect(serialized).toContain(`Couldn't delete the branch: ${REASON}`);
    // The banner has no live region: the merge hook owns the partial
    // announcement, so a second announcement channel would double-speak.
    expect(serialized).not.toContain('polite');
  });

  it('contains NO Button or Pressable (no destructive CTA — there is nothing to retry or undo)', () => {
    const serialized = render(REASON);

    expect(serialized).not.toContain('Button');
    expect(serialized).not.toContain('Pressable');
  });
});
