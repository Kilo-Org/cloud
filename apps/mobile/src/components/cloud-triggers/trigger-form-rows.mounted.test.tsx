/**
 * The switch row carries the row's title as the switch's accessibility label,
 * so a screen reader lands on the switch and announces the setting, not a
 * generic "Enabled". The real `Switch` is stood in by a host element and the
 * label is read off its props.
 */

import { createElement, type ElementType } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { TriggerSwitchRow } from './trigger-form-rows';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
  Switch: 'Switch',
  TextInput: 'TextInput',
  View: 'View',
  useColorScheme: () => 'light',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/haptics', () => ({ selectionHaptic: vi.fn() }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#test-muted' }),
}));

const SWITCH = 'Switch' as ElementType;

function switchRow(root: ReactTestRenderer['root']) {
  const [only] = root.findAll(node => Object.is(node.type, SWITCH));
  if (!only) {
    throw new Error('expected one Switch host in the row');
  }
  return only;
}

describe('trigger switch row label', () => {
  it('labels the switch with the row title', async () => {
    const view = await renderWithProviders(
      createElement(TriggerSwitchRow, {
        title: 'Secret header',
        value: true,
        onValueChange() {
          // no behaviour under test here
        },
      })
    );
    try {
      expect(switchRow(view.renderer.root).props.accessibilityLabel).toBe('Secret header');
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });

  it('keeps the label on the row title, not the switch state', async () => {
    const view = await renderWithProviders(
      createElement(TriggerSwitchRow, {
        title: 'Trigger active',
        value: false,
        onValueChange() {
          // no behaviour under test here
        },
      })
    );
    try {
      expect(switchRow(view.renderer.root).props.accessibilityLabel).toBe('Trigger active');
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });

  it('gives two rows different labels', async () => {
    const view = await renderWithProviders(
      createElement(
        'View',
        null,
        createElement(TriggerSwitchRow, {
          title: 'Secret header',
          value: false,
          onValueChange() {
            // no behaviour under test here
          },
        }),
        createElement(TriggerSwitchRow, {
          title: 'Trigger active',
          value: false,
          onValueChange() {
            // no behaviour under test here
          },
        })
      )
    );
    try {
      const labels = view.renderer.root
        .findAll(node => Object.is(node.type, SWITCH))
        .map(row => row.props.accessibilityLabel as string);
      expect(labels).toStrictEqual(['Secret header', 'Trigger active']);
    } finally {
      act(() => {
        view.renderer.unmount();
      });
    }
  });
});
