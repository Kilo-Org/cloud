// Retry-card contract: a retryable failure shows the stored error plus Retry
// and Discard; a non-retryable failure keeps the card but hides Retry (the
// draft stays so the state survives restart). A stored trial refusal also
// offers the reader who can change the plan the step that ends it, under the
// sentence, without changing the Retry and Discard rules.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SecurityCommandRetryCard } from './security-command-retry-card';

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  Platform: { OS: 'android' },
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
  action?: { label: string; onPress: () => void };
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

function actionSteps(root: I): I[] {
  return root.findAll(
    n =>
      typeof n.type === 'string' &&
      (n.type as string) === 'Pressable' &&
      n.props.accessibilityRole === 'button'
  );
}

describe('SecurityCommandRetryCard', () => {
  it('shows the stored error and both actions for a retryable failure', () => {
    const root = renderCard({
      lastError: 'Network error',
      retryable: true,
      onDiscard: vi.fn((): void => undefined),
    });

    expect(renderedTexts(root.root)).toContain('Network error');
    expect(renderedTexts(root.root)).toContain('Retry');
    expect(renderedTexts(root.root)).toContain('Discard');
    expect(actionSteps(root.root)).toHaveLength(0);
  });

  it('omits Discard when no discard handler is provided', () => {
    const root = renderCard({
      lastError: 'Network error',
      retryable: true,
      onRetry: vi.fn((): void => undefined),
    });

    expect(renderedTexts(root.root)).toContain('Retry');
    expect(renderedTexts(root.root)).not.toContain('Discard');
  });

  it('hides Retry for a non-retryable failure but keeps the card', () => {
    const root = renderCard({ lastError: 'Security service is not configured', retryable: false });

    expect(renderedTexts(root.root)).toContain('Security service is not configured');
    expect(renderedTexts(root.root)).not.toContain('Retry');
    expect(renderedTexts(root.root)).not.toContain('Discard');
  });

  it('offers the trial refusal’s step under the sentence it ends', () => {
    const onPress = vi.fn((): void => undefined);
    const root = renderCard({
      lastError: 'The organization trial has ended.',
      retryable: false,
      action: { label: 'Manage billing', onPress },
    });

    const [step] = actionSteps(root.root);
    if (!step) {
      throw new Error('the card rendered no refusal step');
    }
    expect(step.props.accessibilityLabel).toBe('Manage billing');
    expect(renderedTexts(root.root)).toContain('Manage billing');
    // The step ends the refusal; it is not a retry, so the rules stay as they
    // were for a terminal failure.
    expect(renderedTexts(root.root)).not.toContain('Retry');

    act(() => {
      (step.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
