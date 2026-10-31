// KiloCommandRowView regression coverage for the one-control-per-row rule: the
// visible `/name` and the metadata lines describe the command, but the enabled
// switch is the row's only element that carries the command's name, so a screen
// reader meets the toggle once instead of a name text followed by the switch.
import { act, type ElementType, type ReactElement } from 'react';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { KiloCommandRowView } from './kilo-command-row';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  ChevronUp: 'ChevronUp',
  Pencil: 'Pencil',
  Terminal: 'Terminal',
  Trash2: 'Trash2',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777', destructive: '#FF0000' }),
}));

const TEXT = 'Text' as ElementType;
const SWITCH = 'Switch' as ElementType;

const noop = (): void => undefined;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing KiloCommandRowView renderer');
  }
  return renderer.root;
}

function row(overrides: { enabled?: boolean; onToggle?: (enabled: boolean) => void } = {}) {
  return (
    <KiloCommandRowView
      name="release-notes"
      description="Draft the release notes"
      template="Write the notes"
      subtask={false}
      agent=""
      model=""
      enabled={overrides.enabled ?? true}
      isFirst
      isLast
      onToggle={overrides.onToggle ?? noop}
    />
  );
}

describe('<KiloCommandRowView>', () => {
  it('exposes the command name through the switch alone', () => {
    const root = renderRow(row());

    const nameLines = root
      .findAllByType(TEXT)
      .filter(node => node.props.children === '/release-notes');
    expect(nameLines).toHaveLength(1);
    // Painted, not announced: the switch below carries the name.
    expect(nameLines[0]?.props).toMatchObject({
      accessible: false,
      importantForAccessibility: 'no',
    });

    const switches = root.findAllByType(SWITCH);
    expect(switches.map(node => node.props.accessibilityLabel)).toEqual(['/release-notes']);
  });

  it('keeps the toggle on the switch after the name leaves the accessibility tree', () => {
    const onToggle = vi.fn<(next: boolean) => void>();
    const root = renderRow(row({ onToggle }));

    // The Switch stub keeps the component's own props untyped; the row passes one handler.
    const switchProps = root.findByType(SWITCH).props as { onValueChange?: unknown };
    if (typeof switchProps.onValueChange !== 'function') {
      throw new TypeError('the switch has no value handler');
    }
    const onValueChange = switchProps.onValueChange as (next: boolean) => void;
    act(() => {
      onValueChange(false);
    });

    expect(onToggle).toHaveBeenCalledWith(false);
  });
});
