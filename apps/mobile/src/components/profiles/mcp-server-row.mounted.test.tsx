// McpServerRowView regression coverage for the one-control-per-row rule: the
// server's name is painted once, but the enabled switch is the row's only
// element carrying it, so a screen reader meets the name as the toggle and not
// again as a static text. The type and summary lines stay their own stops
// because they say more than the name does.
import { act, type ElementType, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { TestRenderer } from '@/test/renderer';
import { McpServerRowView } from './mcp-server-row';
import { type McpServerSource } from './profile-mcp-model';

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
  View: 'View',
  Pressable: 'Pressable',
}));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  Lock: 'Lock',
  Pencil: 'Pencil',
  Trash2: 'Trash2',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));

const TEXT = 'Text' as ElementType;
const SWITCH = 'Switch' as ElementType;
const PRESSABLE = 'Pressable' as ElementType;

const server: McpServerSource = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'docs-search',
  type: 'remote',
  enabled: true,
  timeout: null,
  config: { url: 'https://mcp.example.com/docs' },
};

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
    throw new Error('Missing McpServerRowView renderer');
  }
  return renderer.root;
}

function row(overrides: { readOnly?: boolean } = {}) {
  const readOnly = overrides.readOnly === true;
  return (
    <McpServerRowView
      server={server}
      summary="https://mcp.example.com/docs"
      secretCount={2}
      onToggle={readOnly ? undefined : () => undefined}
      onEdit={readOnly ? undefined : () => undefined}
      onDelete={readOnly ? undefined : () => undefined}
    />
  );
}

describe('<McpServerRowView>', () => {
  it('exposes the server name through the switch alone', () => {
    const root = renderRow(row());

    const nameLines = root.findAllByType(TEXT).filter(node => node.props.children === server.name);
    expect(nameLines).toHaveLength(1);
    // Painted, not announced: the switch beside it carries the name.
    expect(nameLines[0]?.props).toMatchObject({
      accessible: false,
      importantForAccessibility: 'no',
    });

    const switches = root.findAllByType(SWITCH);
    expect(switches.map(node => node.props.accessibilityLabel)).toEqual([server.name]);
    expect(switches[0]?.props.value).toBe(true);
  });

  it('keeps the type, the summary and the two action labels as their own stops', () => {
    const root = renderRow(row());

    const announced = root
      .findAllByType(TEXT)
      .filter(node => node.props.accessible !== false)
      .map(node => node.props.children);

    expect(announced).toContain('Remote');
    expect(announced).toContain('https://mcp.example.com/docs');

    const buttons = root.findAllByType(PRESSABLE).map(node => node.props.accessibilityLabel);
    expect(buttons).toEqual(['Edit MCP server docs-search', 'Delete MCP server docs-search']);
  });

  it('carries the enabled state and disables the switch when the profile is read-only', () => {
    let root = renderRow(row());
    expect(root.findAllByType(SWITCH)[0]?.props.disabled).toBe(false);
    expect(root.findAllByType(SWITCH)[0]?.props.value).toBe(true);

    root = renderRow(row({ readOnly: true }));
    expect(root.findAllByType(SWITCH)[0]?.props.disabled).toBe(true);
  });
});
