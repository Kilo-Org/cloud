import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FormField } from './form-field';
import { AccessibleStatus } from './accessible-status';
import { act, TestRenderer } from '@/test/renderer';
import { i18n } from '@/i18n';
import ar from '@/i18n/locales/ar.json';
import en from '@/i18n/locales/en.json';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  View: 'View',
  TextInput: 'TextInput',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));
vi.mock('@/lib/a11y/status-announcement', () => ({ useStatusAnnouncement: vi.fn() }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
});

describe('FormField reserved validation space', () => {
  it.each([
    ['English', en],
    ['Arabic', ar],
  ] as const)(
    'keeps the same full-width reservation across empty, error, and recovery in %s',
    (_language, catalog) => {
      const reserveErrorMessages = [
        catalog.login.pleaseEnterEmail,
        catalog.authErrors.invalidRequest,
        catalog.authErrors.invalidEmail,
      ];
      const props = { label: catalog.login.emailAddress, reserveErrorMessages };
      act(() => {
        renderer = TestRenderer.create(createElement(FormField, props));
      });
      if (!renderer) {
        throw new Error('renderer was not created');
      }
      const mounted = renderer;
      const reservation = () =>
        mounted.root.findByProps({ importantForAccessibility: 'no-hide-descendants' });
      const reserved = reservation();
      expect(reserved.props.className).toBe('flex-row opacity-0');
      expect(reserved.props.pointerEvents).toBe('none');
      expect(reserved.props.accessibilityElementsHidden).toBe(true);
      expect(reserved.children).toHaveLength(3);
      const placeholders = reserved.findAllByType('Text');
      expect(placeholders.map(node => node.props.children)).toEqual(reserveErrorMessages);
      expect(placeholders.map(node => node.props.className)).toEqual([
        'w-full shrink-0 text-sm',
        'w-full shrink-0 text-sm -ms-[100%]',
        'w-full shrink-0 text-sm -ms-[100%]',
      ]);
      expect(mounted.root.findByType(AccessibleStatus).props.message).toBeNull();

      for (const error of [...reserveErrorMessages, undefined]) {
        act(() => {
          mounted.update(createElement(FormField, { ...props, error }));
        });
        expect(reservation()).toBe(reserved);
        expect(reserved.findAllByType('Text').map(node => node.props.children)).toEqual(
          reserveErrorMessages
        );
        const status = mounted.root.findByType(AccessibleStatus);
        expect(status.props.message).toBe(error ?? null);
        expect(status.parent?.props.className).toBe('absolute inset-x-0 top-0');
        expect(status.parent?.parent).toBe(reserved.parent);
        const input = mounted.root.findByType('TextInput');
        if (error) {
          expect(input.props.accessibilityLabel).toContain(error);
          expect(input.props.className).toContain('border-destructive');
          expect(status.findByType('Text').props.accessibilityLiveRegion).toBe('polite');
        } else {
          expect(input.props.accessibilityLabel).toBe(props.label);
          expect(input.props.className).not.toContain('border-destructive');
        }
      }
    }
  );

  it('preserves the unreserved behavior for other fields', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(FormField, {
          label: i18n.t('login.emailAddress'),
          error: i18n.t('login.pleaseEnterEmail'),
        })
      );
    });
    expect(
      renderer?.root.findAllByProps({ importantForAccessibility: 'no-hide-descendants' })
    ).toHaveLength(0);
    expect(renderer?.root.findByType(AccessibleStatus).props.message).toBe(
      i18n.t('login.pleaseEnterEmail')
    );
  });
});
