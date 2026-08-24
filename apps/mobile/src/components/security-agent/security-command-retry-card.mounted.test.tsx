/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Retry-card contract: a retryable failure shows the stored error plus Retry
// and Discard; a non-retryable failure keeps the card but hides Retry (the
// draft stays so the state survives restart).

import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SecurityCommandRetryCard } from './security-command-retry-card';

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ AlertTriangle: 'AlertTriangle' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#B0483A' }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function renderCard(props: {
  lastError: string;
  retryable: boolean;
  onRetry?: () => void;
  onDiscard?: () => void;
}): R {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SecurityCommandRetryCard, props));
  });
  const r = ref.current;
  if (!r) {
    throw new Error('renderer was not created');
  }
  return r;
}

function renderedTexts(root: I): string[] {
  return root
    .findAll(
      n =>
        typeof n.type === 'string' &&
        (n.type as string) === 'Text' &&
        typeof n.props.children === 'string'
    )
    .map(n => n.props.children as string);
}

describe('SecurityCommandRetryCard', () => {
  it('shows the stored error and both actions for a retryable failure', () => {
    const root = renderCard({ lastError: 'Network error', retryable: true });

    expect(renderedTexts(root.root)).toContain('Network error');
    expect(renderedTexts(root.root)).toContain('Retry');
    expect(renderedTexts(root.root)).toContain('Discard');
  });

  it('hides Retry for a non-retryable failure but keeps the card', () => {
    const root = renderCard({ lastError: 'Security service is not configured', retryable: false });

    expect(renderedTexts(root.root)).toContain('Security service is not configured');
    expect(renderedTexts(root.root)).not.toContain('Retry');
    expect(renderedTexts(root.root)).not.toContain('Discard');
  });
});
