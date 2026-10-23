import { createElement } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { type BriefingPeriod } from '@/lib/agent-briefing-period';
import { act, TestRenderer } from '@/test/renderer';
import { BriefingPeriodPicker } from './briefing-period-picker';

vi.mock('react-native', () => ({ View: 'View', Platform: { OS: 'android' } }));
vi.mock('@expo/ui/community/datetime-picker', () => ({ DateTimePicker: 'NativeDateTimePicker' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key, language: 'en' } }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

afterEach(() => vi.unstubAllEnvs());

it('keeps the selected Android calendar day when the device timezone is behind UTC', () => {
  vi.stubEnv('TZ', 'America/Los_Angeles');
  const onChange = vi.fn<(period: BriefingPeriod) => void>();
  const period = { startAt: '2026-10-19T10:00:00.000Z', endAt: '2026-10-20T10:00:00.000Z' };
  const holder: { renderer?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.renderer = TestRenderer.create(
      createElement(BriefingPeriodPicker, {
        period,
        timezone: 'Europe/Belgrade',
        disabled: false,
        onChange,
      })
    );
  });
  const mounted = holder.renderer;
  if (!mounted) {
    throw new Error('Picker is not mounted');
  }
  const startDate = mounted.root.findAll(node => (node.type as string) === 'Button')[0];
  if (!startDate) {
    throw new Error('Start date control is missing');
  }
  const startProps = startDate.props as { onPress: () => void };
  act(() => {
    startProps.onPress();
  });
  const picker = mounted.root.find(node => (node.type as string) === 'NativeDateTimePicker');
  const pickerProps = picker.props as { onValueChange: (event: object, date: Date) => void };
  act(() => {
    pickerProps.onValueChange({}, new Date('2026-10-15T00:00:00.000Z'));
  });
  expect(onChange).toHaveBeenCalledWith({ ...period, startAt: '2026-10-15T10:00:00.000Z' });
  act(() => {
    mounted.unmount();
  });
});
