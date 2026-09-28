import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { QueryError } from './query-error';

// The retry action is the only stateful part under test: EmptyState (and its
// measured placement) and the primitives are stubbed so the label and the
// press handler are asserted on the button the component itself builds.
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ action }: { action?: ReactNode }) => createElement('EmptyState', null, action),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: () => null,
  Lock: () => null,
  SearchX: () => null,
  ServerCrash: () => null,
  WifiOff: () => null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/** The retry button's props, including the label it renders. */
type RetryButtonProps = { onPress: () => void; children: { props: { children: string } } };

describe('QueryError retry action', () => {
  it('defaults the label to the generic Retry for callers that pass none', async () => {
    const onRetry = vi.fn<() => void>();
    const mounted = await renderWithProviders(<QueryError onRetry={onRetry} />);

    const retry = mounted.renderer.root.findByProps({ accessibilityLabel: 'common.retry' })
      .props as RetryButtonProps;
    expect(retry.children.props.children).toBe('common.retry');
    retry.onPress();
    expect(onRetry).toHaveBeenCalledOnce();
    mounted.unmount();
  });

  it('uses the caller label on both the visible and the accessibility label', async () => {
    const mounted = await renderWithProviders(
      <QueryError onRetry={vi.fn<() => void>()} retryLabel="Refresh repositories" />
    );

    const retry = mounted.renderer.root.findByProps({
      accessibilityLabel: 'Refresh repositories',
    }).props as RetryButtonProps;
    expect(retry.children.props.children).toBe('Refresh repositories');
    expect(
      mounted.renderer.root.findAllByProps({ accessibilityLabel: 'common.retry' })
    ).toHaveLength(0);
    mounted.unmount();
  });
});
