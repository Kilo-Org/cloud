// RenameModal backs both the rename dialogs (short single-line names) and the
// Edit goal dialog (prose that can hold a long unbroken line). A single-line
// field scrolls horizontally and clips the start of a long value, so the goal
// dialog opts into the wrapping field. These tests pin both field contracts:
// multi-line wraps with a bounded height, single-line keeps its old styling.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RenameModal } from './rename-modal';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  View: 'View',
  // `@/components/ui/input` reads `I18nManager.isRTL` through
  // `withRtlInputAlignment` on every render.
  I18nManager: { isRTL: false },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// `@/components/ui/dialog` reaches `DestructiveConfirmDialog`, which reads the
// bottom inset; the native module cannot load under this partial RN mock.
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 24, left: 0, right: 0, top: 0 }),
}));
// `withUiDeadline` reads its timeout copy from here; the field contract under
// test never reaches it.
vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#8b8b8b' }),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
}));

/** The reported shape: one very long word plus a long sentence. */
const LONG_GOAL =
  'the_number_of_consecutive_days_the_workflow_has_not_failed_for_the_fir' +
  'st_time_due_to_workflow_issues_is_0_for_3_consecutive_days and the ' +
  'scheduled_cleanup_job_must_keep_reporting_its_status_without_a_failure';

const mounted: TestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

/** Resolves the save promise the modal awaits; these tests never press Save. */
async function resolveSave(): Promise<void> {
  await Promise.resolve();
}

function mount(multiline: boolean): TestRenderer.ReactTestRenderer {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    holder.current = TestRenderer.create(
      createElement(RenameModal, {
        title: 'Edit goal',
        placeholder: 'Describe the goal',
        initialValue: LONG_GOAL,
        multiline,
        maxLength: 500,
        onSave: resolveSave,
        onClose: () => undefined,
      })
    );
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('RenameModal did not mount');
  }
  mounted.push(renderer);
  return renderer;
}

function fieldProps(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('TextInput').props as {
    multiline?: boolean;
    textAlignVertical?: string;
    defaultValue?: string;
  };
}

describe('RenameModal field wrapping', () => {
  it('wraps a long goal value in a multi-line field', () => {
    const props = fieldProps(mount(true));
    // `multiline` is what makes the native field soft-wrap instead of
    // scrolling horizontally and hiding the start of the value.
    expect(props.multiline).toBe(true);
    expect(props.textAlignVertical).toBe('top');
    expect(props.defaultValue).toBe(LONG_GOAL);
  });

  it('keeps the rename field single-line', () => {
    const props = fieldProps(mount(false));
    expect(props.multiline).toBeFalsy();
  });
});
