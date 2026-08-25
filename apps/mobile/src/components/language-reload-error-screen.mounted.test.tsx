/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as language-picker-sheet.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { LanguageReloadErrorScreen } from '@/components/language-reload-error-screen';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findButtons(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === 'Button');
}

function findButtonByAccessibilityLabel(
  root: TestRenderer.ReactTestInstance,
  label: string
): TestRenderer.ReactTestInstance {
  const button = findButtons(root).find(node => node.props.accessibilityLabel === label);
  if (!button) {
    throw new Error(`Button with accessibility label ${label} not found`);
  }
  return button;
}

async function mountScreen(
  onRetry: () => void,
  onContinue: () => void
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    ref.current = TestRenderer.create(
      createElement(LanguageReloadErrorScreen, { onRetry, onContinue })
    );
    await Promise.resolve();
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('LanguageReloadErrorScreen', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('renders Retry and Continue above the splash and wires the callbacks', async () => {
    const onRetry = vi.fn<() => void>();
    const onContinue = vi.fn<() => void>();
    const renderer = await mountScreen(onRetry, onContinue);

    const retryButton = findButtonByAccessibilityLabel(renderer.root, 'Retry');
    const continueButton = findButtonByAccessibilityLabel(renderer.root, 'Continue');

    act(() => {
      (retryButton.props.onPress as () => void)();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onContinue).not.toHaveBeenCalled();

    act(() => {
      (continueButton.props.onPress as () => void)();
    });
    expect(onContinue).toHaveBeenCalledTimes(1);

    renderer.unmount();
  });
});
