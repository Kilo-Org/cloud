// McpServerRowView regression coverage for the one-control-per-row rule: the
// server's name is painted once, but the enabled switch is the row's only
// element carrying it, so a screen reader meets the name as the toggle and not
// again as a static text. The type, the count and the summary are painted under
// that name, and the content press is one element, so they ride its spoken name
// instead of becoming stops of their own.
import { act, type ElementType, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ReactTestInstance, TestRenderer } from '@/test/renderer';
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
  Server: 'Server',
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

function row(overrides: { readOnly?: boolean; showType?: boolean } = {}) {
  const readOnly = overrides.readOnly === true;
  return (
    <McpServerRowView
      server={server}
      summary="https://mcp.example.com/docs"
      secretCount={2}
      showType={overrides.showType ?? true}
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

  it('names the content press with the type, the secret count and the summary', () => {
    const root = renderRow(row());

    const announced = root
      .findAllByType(TEXT)
      .filter(node => node.props.accessible !== false)
      .map(node => node.props.children);

    // The painted lines are merged into the content press, so none of them is a
    // stop of its own.
    expect(announced).not.toContain('Remote');
    expect(announced).not.toContain('https://mcp.example.com/docs');

    // A URL is told apart by its tail, so the value ellipsizes in the middle.
    const summary = root
      .findAllByType(TEXT)
      .find(node => node.props.children === 'https://mcp.example.com/docs');
    expect(summary?.props.ellipsizeMode).toBe('middle');

    const buttons = root.findAllByType(PRESSABLE).map(node => node.props.accessibilityLabel);
    expect(buttons).toEqual([
      'Edit MCP server docs-search, Remote, 2 secrets, https://mcp.example.com/docs',
      'Delete MCP server docs-search',
    ]);
  });

  it('leaves out the type the whole list shares, and keeps the count in the name', () => {
    const root = renderRow(row({ showType: false }));

    const buttons = root.findAllByType(PRESSABLE).map(node => node.props.accessibilityLabel);
    expect(buttons).toEqual([
      'Edit MCP server docs-search, 2 secrets, https://mcp.example.com/docs',
      'Delete MCP server docs-search',
    ]);
  });

  it('gives the name its own line and leaves the type and count to the line under it', () => {
    const root = renderRow(row());

    const nameLine = root.findAllByType(TEXT).find(node => node.props.children === server.name);
    const body = nameLine?.parent ?? null;
    if (nameLine === undefined || body === null) {
      throw new Error('Missing the server name line');
    }
    const lines = body.children.filter(
      (child): child is ReactTestInstance => typeof child !== 'string'
    );

    // Nothing paints beside the name, so a compact card cannot squeeze it to make
    // room for the secondary type label and key count.
    expect(lines.map(line => line.findAllByType(TEXT).map(node => node.props.children))).toEqual([
      [server.name],
      ['Remote', 2],
      ['https://mcp.example.com/docs'],
    ]);
  });

  it('leaves the type out when the whole list is one kind, and keeps the key count', () => {
    const root = renderRow(row({ showType: false }));

    const nameLine = root.findAllByType(TEXT).find(node => node.props.children === server.name);
    const body = nameLine?.parent ?? null;
    if (nameLine === undefined || body === null) {
      throw new Error('Missing the server name line');
    }
    const lines = body.children.filter(
      (child): child is ReactTestInstance => typeof child !== 'string'
    );

    expect(lines.map(line => line.findAllByType(TEXT).map(node => node.props.children))).toEqual([
      [server.name],
      [2],
      ['https://mcp.example.com/docs'],
    ]);
  });

  it('carries the enabled state and disables the switch when the profile is read-only', () => {
    let root = renderRow(row());
    expect(root.findAllByType(SWITCH)[0]?.props.disabled).toBe(false);
    expect(root.findAllByType(SWITCH)[0]?.props.value).toBe(true);

    root = renderRow(row({ readOnly: true }));
    expect(root.findAllByType(SWITCH)[0]?.props.disabled).toBe(true);
  });
});
