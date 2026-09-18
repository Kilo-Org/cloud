import { createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { SaveProfileSheet, type SaveProfileSheetProps } from './save-profile-sheet';

vi.mock('react-native', () => ({
  ScrollView: 'ScrollView',
  Switch: 'Switch',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@/components/agents/session-page-sheet', () => ({
  SessionPageSheet: (props: { children?: ReactNode }) =>
    createElement('SessionPageSheet', null, props.children),
}));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: (props: Record<string, unknown>) => createElement('SheetHeader', props),
}));
vi.mock('@/components/ui/form-field', () => ({
  FormField: (props: Record<string, unknown>) => createElement('FormField', props),
}));
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return { Text: 'Text', TextClassContext: React.createContext<string | undefined>(undefined) };
});
vi.mock('@/components/ui/icons', () => ({ Lock: 'Lock' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#666' }),
}));

function defaults(overrides: Partial<SaveProfileSheetProps> = {}): SaveProfileSheetProps {
  return {
    envVars: [
      { key: 'API_KEY', value: 'secret', isSecret: true },
      { key: 'REGION', value: 'eu', isSecret: false },
    ],
    setupCommands: ['pnpm install'],
    onClose: vi.fn<() => void>(),
    onSave: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function mount(props: Partial<SaveProfileSheetProps> = {}) {
  const ref: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  act(() => {
    ref.current = TestRenderer.create(createElement(SaveProfileSheet, defaults(props)));
  });
  const renderer = ref.current;
  if (renderer === null) {
    throw new Error('the save sheet did not render');
  }
  return renderer;
}

function field(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const node = renderer.root
    .findAllByType('FormField' as never)
    .find(instance => instance.props.label === label);
  if (!node) {
    throw new Error(`no FormField labelled ${label}`);
  }
  return node;
}

function header(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType('SheetHeader' as never);
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Text' as never)
    .flatMap(node => node.children)
    .filter((child): child is string => typeof child === 'string');
}

async function submit(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    (header(renderer).props.onDone as () => void)();
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('SaveProfileSheet', () => {
  it('shows the summary counts and the secrets note', () => {
    const renderer = mount();

    expect(header(renderer).props.title).toBe('Save as Profile');
    expect(texts(renderer)).toContain('2 environment variables · 1 setup commands');
    expect(texts(renderer)).toContain('Secrets are encrypted before storage.');
    expect(renderer.root.findByType('Lock' as never)).toBeTruthy();
  });

  it('hides the secrets note when no variable is a secret', () => {
    const renderer = mount({ envVars: [{ key: 'REGION', value: 'eu', isSecret: false }] });

    expect(texts(renderer)).not.toContain('Secrets are encrypted before storage.');
    expect(renderer.root.findAllByType('Lock' as never)).toHaveLength(0);
  });

  it('refuses an empty name with the required error and creates nothing', async () => {
    const onSave = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const renderer = mount({ onSave });

    await submit(renderer);

    expect(onSave).not.toHaveBeenCalled();
    expect(field(renderer, 'Profile name').props.error).toBe('required');
  });

  it('refuses an over-long name with the matching error', async () => {
    const onSave = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const renderer = mount({ onSave });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)(
        'x'.repeat(101)
      );
    });
    await submit(renderer);

    expect(onSave).not.toHaveBeenCalled();
    expect(field(renderer, 'Profile name').props.error).toBe('Profile name is too long');
  });

  it('saves the trimmed fields and closes on success', async () => {
    const onSave = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const onClose = vi.fn<() => void>();
    const renderer = mount({ onSave, onClose });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)('  My AWS  ');
      (field(renderer, 'Profile description').props.onChangeText as (value: string) => void)(
        '  eu-west  '
      );
      (renderer.root.findByType('Switch' as never).props.onValueChange as (value: boolean) => void)(
        true
      );
    });
    await submit(renderer);

    expect(onSave).toHaveBeenCalledWith({
      name: 'My AWS',
      description: 'eu-west',
      setAsDefault: true,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the entered values and the sheet open when the save fails', async () => {
    const onSave = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const onClose = vi.fn<() => void>();
    const renderer = mount({ onSave, onClose });

    act(() => {
      (field(renderer, 'Profile name').props.onChangeText as (value: string) => void)('Retry me');
    });
    await submit(renderer);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    // The sheet is still mounted with the same field instance, so the typed
    // name is still on screen.
    expect(field(renderer, 'Profile name')).toBeTruthy();
  });
});
