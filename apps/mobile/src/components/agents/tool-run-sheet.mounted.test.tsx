/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import '@/i18n';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { FixedPartRow } from './fixed-part-row';
import { ToolRunSheet } from './tool-run-sheet';

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    background: '#000000',
    foreground: '#ffffff',
    mutedForeground: '#999999',
    destructive: '#BE4E3F',
  }),
}));
vi.mock('react-native', () => ({
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/centered-state-surface', () => ({ StateSurface: 'StateSurface' }));
vi.mock('@/components/sheet-header', () => ({ SheetHeader: 'SheetHeader' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
// The Flow-sourced react-native runtime cannot parse under vitest, so the icon
// module is stubbed with sentinels; the sheet only reads the mappings.
vi.mock('@/components/ui/icons', () => ({
  Cpu: 'Cpu',
  Eye: 'Eye',
  FileDiff: 'FileDiff',
  FilePlus: 'FilePlus',
  FileSearch: 'FileSearch',
  FolderOpen: 'FolderOpen',
  Globe: 'Globe',
  ListTodo: 'ListTodo',
  Pencil: 'Pencil',
  Plug: 'Plug',
  Rows3: 'Rows3',
  Search: 'Search',
  Sparkles: 'Sparkles',
  Terminal: 'Terminal',
  XCircle: 'XCircle',
}));

function makePart(id: string, tool: string, input: Record<string, unknown>): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input,
      output: '',
      title: tool,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

/** Three parts with distinct labels: app.ts, List files, new-file.ts. */
const PARTS: ToolPart[] = [
  makePart('t1', 'read', { filePath: '/repo/app.ts' }),
  makePart('t2', 'bash', { description: 'List files' }),
  makePart('t3', 'write', { filePath: 'new-file.ts' }),
];

/** A tool part whose untrusted input is not an object: `getToolDisplay` throws. */
function malformedPart(id: string): ToolPart {
  const part = makePart(id, 'read', {});
  return {
    ...part,
    state: { ...part.state, input: null as unknown as Record<string, unknown> },
  };
}

async function mountSheet(
  parts: readonly ToolPart[],
  onOpenPart: (partId: string) => void = vi.fn()
): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(
      createElement(ToolRunSheet, {
        visible: true,
        parts,
        onClose: vi.fn<() => void>(),
        onOpenPart,
      })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function propOf(instance: TestRenderer.ReactTestInstance, key: string): unknown {
  /* eslint-disable-next-line typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
}

function rowPress(instance: TestRenderer.ReactTestInstance): void {
  (propOf(instance, 'onPress') as () => void)();
}

function textsOf(root: TestRenderer.ReactTestInstance): unknown[] {
  return root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => propOf(node, 'children'));
}

describe('ToolRunSheet mounted', () => {
  it('lists every tool call of the run in order with each part own label', async () => {
    const renderer = await mountSheet(PARTS);

    const rows = renderer.root.findAllByType(FixedPartRow);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => propOf(row, 'label'))).toEqual(['app.ts', 'List files', 'new-file.ts']);

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('forwards the pressed row part id to onOpenPart', async () => {
    const onOpenPart = vi.fn<(partId: string) => void>();
    const renderer = await mountSheet(PARTS, onOpenPart);

    const rows = renderer.root.findAllByType(FixedPartRow);
    const second = rows[1];
    if (!second) {
      throw new Error('second row not found');
    }
    await act(async () => {
      await Promise.resolve();
      rowPress(second);
    });

    expect(onOpenPart).toHaveBeenCalledTimes(1);
    expect(onOpenPart).toHaveBeenCalledWith('t2');

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('keeps the sheet alive when one row cannot render', async () => {
    const renderer = await mountSheet([
      makePart('t1', 'read', { filePath: '/repo/app.ts' }),
      malformedPart('bad'),
      makePart('t3', 'write', { filePath: 'new-file.ts' }),
    ]);

    expect(renderer.root.findAllByType(FixedPartRow)).toHaveLength(2);
    expect(textsOf(renderer.root)).toContain('Failed to render content');

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });

  it('shows the unavailable copy and no rows when the run is empty', async () => {
    const renderer = await mountSheet([]);

    expect(renderer.root.findAllByType(FixedPartRow)).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node => typeof node.type === 'string' && (node.type as string) === 'CenteredState'
      )
    ).toHaveLength(1);
    expect(textsOf(renderer.root)).toContain('Details unavailable');

    await act(async () => {
      await Promise.resolve();
      renderer.unmount();
    });
  });
});
