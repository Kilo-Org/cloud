import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrReviewOverviewSkeleton } from './pr-review-overview-skeleton';
import { renderWithProviders } from '@/test/render-with-providers';

vi.mock('react-native', () => ({ View: 'View' }));
// Skeleton pulls the motion policy through expo modules, which the node-env
// mounted harness cannot transform; the bars are asserted structurally.
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

describe('PrReviewOverviewSkeleton', () => {
  it('announces the pending body as one busy progress region', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(PrReviewOverviewSkeleton)
    );
    const region = renderer.root.find(
      node => String(node.type) === 'View' && node.props.accessibilityRole === 'progressbar'
    );
    // The body is the only thing on screen until the read settles, so it has to
    // reach assistive technology as a labelled busy region rather than as a
    // group of decorative bars.
    expect(region.props.accessible).toBe(true);
    expect(region.props.accessibilityLabel).toBe('Loading…');
    expect(region.props.accessibilityState).toEqual({ busy: true });
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton').length).toBeGreaterThan(
      0
    );
    unmount();
  });
});
