import { createElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders, type RenderWithProvidersResult } from '@/test/render-with-providers';

import { QueryError } from './query-error';

// The retry action and the contract props the state hands to EmptyState are
// the parts under test: EmptyState (and its measured placement) and the
// primitives are stubbed so the label, the press handler, the destructive icon
// and the muted description tone are asserted on what the component itself
// builds.
type EmptyStateProps = {
  action?: ReactNode;
  iconColor?: string;
  compactTitleClassName?: string;
  description?: ReactElement<{ tone?: string }>;
};

vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: EmptyStateProps) =>
    createElement('EmptyState', props, props.description, props.action),
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
vi.mock('@/lib/a11y/tap-target', () => ({ STATE_ACTION_CLASS: 'min-h-[48px]' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#ff0000' }),
}));

/** The retry button's props, including the label it renders. */
type RetryButtonProps = { onPress: () => void; children: { props: { children: string } } };

function emptyStateProps(mounted: RenderWithProvidersResult): EmptyStateProps {
  return mounted.renderer.root.findByType('EmptyState' as never).props as EmptyStateProps;
}

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

describe('QueryError state emphasis', () => {
  it('keeps the message secondary and puts the error cue on the icon', async () => {
    const mounted = await renderWithProviders(<QueryError onRetry={vi.fn<() => void>()} />);

    const props = emptyStateProps(mounted);
    // The explanatory line is muted ink; the announcement tone stays separate.
    expect(props.description?.props.tone).toBe('status');
    expect(props.iconColor).toBe('#ff0000');
    mounted.unmount();
  });

  it('hands the compact form its own title tint, because that form drops the icon', async () => {
    const mounted = await renderWithProviders(<QueryError onRetry={vi.fn<() => void>()} />);

    expect(emptyStateProps(mounted).compactTitleClassName).toBe('text-destructive');
    mounted.unmount();
  });
});
