import { type ComponentProps } from 'react';
import { I18nManager, Pressable } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SlidersHorizontal } from '@/components/ui/icons';
import { i18n } from '@/i18n';
import { renderWithProviders } from '@/test/render-with-providers';
import { act } from '@/test/renderer';
import { SessionFilterButton } from './session-filter-button';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ SlidersHorizontal: 'SlidersHorizontal' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#14130f', mutedForeground: '#6f6a61' }),
}));

const mounted: Awaited<ReturnType<typeof renderWithProviders>>[] = [];

afterEach(async () => {
  for (const view of mounted) {
    view.unmount();
  }
  mounted.length = 0;
  I18nManager.isRTL = false;
  await i18n.changeLanguage('en');
});

describe('SessionFilterButton touch target', () => {
  it.each(['en', 'ar'])(
    'reserves a 44dp target through filter-count changes in %s',
    async language => {
      await i18n.changeLanguage(language);
      I18nManager.isRTL = language === 'ar';
      const onPress = vi.fn<() => void>();
      const view = await renderWithProviders(
        <SessionFilterButton activeCount={0} onPress={onPress} testID="agents-open-filters" />
      );
      mounted.push(view);

      for (const activeCount of [0, 1, 12, 0]) {
        act(() => {
          view.renderer.update(
            <SessionFilterButton
              activeCount={activeCount}
              onPress={onPress}
              testID="agents-open-filters"
            />
          );
        });
        const button = view.renderer.root.findByType(Pressable);
        const props = button.props as ComponentProps<typeof Pressable>;
        // NativeWind's rem scale is not 16dp; explicit px keeps this at 44dp.
        expect(props.className?.split(' ')).toEqual(
          expect.arrayContaining([
            'h-[44px]',
            'w-[44px]',
            'shrink-0',
            'items-center',
            'justify-center',
            'active:opacity-70',
          ])
        );
        expect(props.hitSlop).toBeUndefined();
        expect(props.accessibilityRole).toBe('button');
        const title = i18n.t('agentChat.sessionFilter.title');
        expect(props.accessibilityLabel).toBe(activeCount > 0 ? `${title}, ${activeCount}` : title);
        expect(props.testID).toBe('agents-open-filters');
        const icon = button.findByType(SlidersHorizontal);
        expect(icon.props).toMatchObject({
          size: 20,
          color: activeCount > 0 ? '#14130f' : '#6f6a61',
        });
        expect(icon.parent?.props.pointerEvents).toBe('none');
        const badges = button.findAllByProps({ testID: 'session-filter-badge' });
        expect(badges).toHaveLength(activeCount > 0 ? 1 : 0);
        if (activeCount > 0) {
          expect(badges[0]?.props.children).toBe(activeCount);
          expect(badges[0]?.parent?.props.pointerEvents).toBe('none');
          expect(badges[0]?.parent?.parent).toBe(icon.parent);
          expect(badges[0]?.parent?.props.className).toContain('absolute');
        }
        act(() => {
          (button.props.onPress as () => void)();
        });
      }
      expect(onPress).toHaveBeenCalledTimes(4);
    }
  );
});
