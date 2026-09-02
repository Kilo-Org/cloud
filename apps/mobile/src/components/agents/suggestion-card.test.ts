import * as React from 'react';
import { Alert } from 'react-native';
import type * as ReactI18next from 'react-i18next';
import { expect, it, vi } from 'vitest';

import { SuggestionCard as renderSuggestionCard } from './suggestion-card';

vi.mock('react', async importOriginal => ({
  ...(await importOriginal<typeof React>()),
  useRef: <T>(current: T) => ({ current }),
  useState: <T>(initial: T) => [initial, vi.fn()],
}));
vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => ({ t: actual.getI18n().t.bind(actual.getI18n()) }),
  };
});
vi.mock('expo-haptics', () => ({ impactAsync: vi.fn() }));
vi.mock('@/components/ui/icons', () => ({ Sparkles: 'Sparkles', X: 'X' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

it('opens the full suggestion and action descriptions without accepting or dismissing', () => {
  const text = 'Choose the next step.\nReview only the uncommitted changes before continuing.';
  const onAccept = vi.fn<() => Promise<void>>();
  const onDismiss = vi.fn<() => Promise<void>>();
  const root = renderSuggestionCard({
    text,
    actions: [
      {
        label: 'Review',
        description: 'Inspect every changed file.\nDo not edit.',
        prompt: '/review',
      },
      { label: 'Test', prompt: 'Run the tests' },
    ],
    onAccept,
    onDismiss,
  });
  const scroll = (root.props as { children: React.ReactElement[] }).children[0];
  if (!scroll) {
    throw new Error('Suggestion scroll view not found');
  }
  const chip = (scroll.props as { children: React.ReactElement[] }).children[0];
  if (!chip) {
    throw new Error('Suggestion chip not found');
  }
  expect(chip.type).toBe('Pressable');
  const props = chip.props as { onPress: () => void };
  expect(props).toMatchObject({
    accessibilityRole: 'button',
    accessibilityLabel: text,
    accessibilityHint: 'Show details',
  });

  props.onPress();

  expect(Alert.alert).toHaveBeenCalledExactlyOnceWith(
    'Suggestion',
    `${text}\n\nReview\nInspect every changed file.\nDo not edit.\n\nTest`,
    [{ text: 'Done' }]
  );
  expect(onAccept).not.toHaveBeenCalled();
  expect(onDismiss).not.toHaveBeenCalled();
});
