/* eslint-disable typescript-eslint/no-deprecated -- the DOM-free `test-renderer` mounts React/RN trees under vitest (see src/test/renderer.ts) */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpServersSection } from '@/components/chat/mcp-servers-section';
import { type RemoteMcpServerRow } from '@/components/chat/mcp-settings-state';
import { i18n } from '@/i18n';
import { act, TestRenderer } from '@/test/renderer';

/**
 * The remote servers section, drawn from its props alone.
 *
 * The list has four states and this file pins each one at the section: the
 * skeleton while the store is still being read, the empty state once it is read
 * and empty, a row with a Retry when its discovery failed, and a row with no
 * Retry when it answered. The Add button is checked in the loading and empty
 * states because it is the section's, not the list's, and must not be lost.
 */

vi.mock('react-native', () => ({
  Switch: 'Switch',
  View: 'View',
}));

vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Server: 'Server' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type Props = Parameters<typeof McpServersSection>[0];

const row = (over: Partial<RemoteMcpServerRow> = {}): RemoteMcpServerRow => ({
  id: 'alpha',
  name: 'Alpha',
  url: 'https://alpha.example/mcp',
  enabled: true,
  statusKey: 'modelChat.mcp.serverToolCount',
  toolCount: 3,
  retry: false,
  canEdit: true,
  canDelete: true,
  ...over,
});

let renderer: ReturnType<typeof TestRenderer.create> | undefined = undefined;

async function mount(over: Partial<Props> = {}): Promise<void> {
  const props: Props = {
    loaded: true,
    servers: [],
    retryingIds: [],
    onToggle: () => undefined,
    onEdit: () => undefined,
    onDelete: () => undefined,
    onRetry: () => undefined,
    onAdd: () => undefined,
    ...over,
  };
  renderer = TestRenderer.create(createElement(McpServersSection, props));
  await act(async () => {
    await Promise.resolve();
  });
}

function nodes(type: string): TestRenderer.ReactTestInstance[] {
  return renderer?.root.findAll(node => (node.type as string) === type) ?? [];
}

function buttonFor(label: string): TestRenderer.ReactTestInstance | undefined {
  return nodes('Button').find(
    button =>
      button.findAll(node => (node.type as string) === 'Text' && node.props.children === label)
        .length > 0
  );
}

/** The node, or a failure that says which one the section did not draw. */
function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`${what} was not rendered`);
  }
  return value;
}

afterEach(() => {
  renderer?.unmount();
  renderer = undefined;
});

describe('the remote servers section', () => {
  it('draws a row-shaped skeleton, not the empty state, until the list is read', async () => {
    await mount({ loaded: false, servers: [] });

    expect(nodes('Skeleton').length).toBeGreaterThan(0);
    expect(nodes('EmptyState')).toHaveLength(0);
    // The way to add one belongs to the section, so the wait never hides it.
    expect(buttonFor('Add MCP server')).toBeDefined();
  });

  it('shows the empty state once the list is read and there are no servers', async () => {
    await mount({ loaded: true, servers: [] });

    const empty = required(nodes('EmptyState')[0], 'EmptyState');
    expect(empty.props.title).toBe(i18n.t('modelChat.mcp.serversEmptyTitle'));
    expect(empty.props.description).toBe(i18n.t('modelChat.mcp.serversEmptyDescription'));
    expect(nodes('Skeleton')).toHaveLength(0);
    expect(buttonFor('Add MCP server')).toBeDefined();
  });

  it('draws a row, and no skeleton, once the list has servers', async () => {
    await mount({ loaded: true, servers: [row()] });

    expect(nodes('Skeleton')).toHaveLength(0);
    expect(nodes('EmptyState')).toHaveLength(0);
    expect(buttonFor('Edit server')).toBeDefined();
    expect(buttonFor('Retry')).toBeUndefined();
  });

  it('offers a Retry on a failed row and asks for that server', async () => {
    const onRetry = vi.fn<(id: string) => void>();
    await mount({
      servers: [row({ retry: true, statusKey: 'modelChat.mcp.serverUnreachable', toolCount: 0 })],
      onRetry,
    });

    const retry = required(buttonFor('Retry'), 'Retry');
    await act(async () => {
      (retry.props.onPress as () => void)();
      await Promise.resolve();
    });

    expect(onRetry).toHaveBeenCalledWith('alpha');
  });

  it('shows the working state on the row whose Retry is in flight', async () => {
    await mount({
      servers: [row({ retry: true, statusKey: 'modelChat.mcp.serverUnreachable', toolCount: 0 })],
      retryingIds: ['alpha'],
    });

    expect(required(buttonFor('Retry'), 'Retry').props.loading).toBe(true);
  });

  it('keeps Retry on the row that asked, even after discovery leaves failed', async () => {
    await mount({
      servers: [row({ retry: false, statusKey: 'modelChat.mcp.serverChecking', toolCount: 0 })],
      retryingIds: ['alpha'],
    });

    expect(required(buttonFor('Retry'), 'Retry').props.loading).toBe(true);
  });
});
