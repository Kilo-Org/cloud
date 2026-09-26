/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/renderer.tsx) */
import '@/i18n';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfig } from '@/lib/tool-summary-translation/tool-summary-translation-runtime';

import { textWithContent } from './fixed-part-row.mounted.test-helpers';
import { CondensedToolRunRow } from './tool-run-rows';

const { requestMock, readMock, writeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('@/lib/tool-summary-translation/tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
// The encrypted-KV cache is a native module, loaded by the runtime's dynamic
// import; mock it the same way as the client so the suite stays native-free and
// hydration settles before the batch window closes.
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
// The Flow-sourced react-native runtime cannot parse under vitest, so the icon
// module is stubbed with sentinels; the row only reads the mappings.
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
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#999999', destructive: '#BE4E3F' }),
}));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

function makePart(id: string, tool: string, input: Record<string, unknown> = {}): ToolPart {
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

/**
 * A three-part run whose last summary is the file name the row must show when
 * translation is off, and the text the gateway must translate when it is on.
 */
function runOf(lastLabel: string): ToolPart[] {
  return [
    makePart('t1', 'read', { filePath: '/repo/app.ts' }),
    makePart('t2', 'bash', { description: 'List files' }),
    makePart('t3', 'write', { filePath: lastLabel }),
  ];
}

function renderCondensed(parts: readonly ToolPart[]): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  // Sync commit so the pre-resolution render stays observable: the dynamic
  // import cannot resolve inside the synchronous `act`.
  act(() => {
    ref.current = TestRenderer.create(createElement(CondensedToolRunRow, { parts }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function settleTranslation(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- sequential macrotask flushes settle the batch window, the dynamic import and the request
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20);
      });
    }
  });
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && (node.type as string) === 'Text')
    .map(node => (typeof node.props.children === 'string' ? node.props.children : ''));
}

beforeEach(() => {
  requestMock.mockReset();
  readMock.mockReset();
  writeMock.mockReset();
  readMock.mockResolvedValue([]);
  writeMock.mockResolvedValue(undefined);
  setConfig({ enabled: false, model: MODEL });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Long past any retry cadence the row uses for an unresolved summary. */
const RETRY_WINDOW_MS = 60_000;

/**
 * Longer than the runtime's 40 ms batch window: a summary the row asked for has
 * left the window and its request has been issued.
 */
const BATCH_WINDOW_SETTLE_MS = 60;

/** Advance the fake clock and let the pending import/request microtasks settle. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.dynamicImportSettled();
  });
}

describe('CondensedToolRunRow label', () => {
  it('reads "n items; last summary" with the last tool call summary when translation is off', () => {
    const renderer = renderCondensed(runOf('resolved.ts'));

    expect(textWithContent(renderer.root, '3 items; resolved.ts')).toHaveLength(1);
    expect(requestMock).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('translates the last summary in the label when tool translation is on', async () => {
    requestMock.mockResolvedValue(['Nouveau fichier']);
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderCondensed(runOf('resolved.ts'));

    // Uncached: the count renders alone, never the summary's raw text.
    expect(textWithContent(renderer.root, '3 items')).toHaveLength(1);
    expect(texts(renderer).some(text => text.includes('resolved.ts'))).toBe(false);
    await settleTranslation();

    expect(textWithContent(renderer.root, '3 items; Nouveau fichier')).toHaveLength(1);
    expect(requestMock).toHaveBeenCalledWith({
      texts: ['resolved.ts'],
      targetLanguage: 'en',
      model: MODEL.id,
    });
    renderer.unmount();
  });

  it('degrades to the item count alone while the translation is unresolved', async () => {
    requestMock.mockReturnValue(new Promise(() => undefined));
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderCondensed(runOf('untranslated.ts'));

    await settleTranslation();

    expect(textWithContent(renderer.root, '3 items')).toHaveLength(1);
    expect(texts(renderer).some(text => text.includes('untranslated.ts'))).toBe(false);
    renderer.unmount();
  });

  it('recovers the last summary after a failed request instead of staying count-only', async () => {
    requestMock.mockResolvedValueOnce([null]).mockResolvedValue(['Nouveau fichier']);
    setConfig({ enabled: true, model: MODEL });
    vi.useFakeTimers();
    // A summary no sibling test cached, so the first request really is made.
    const renderer = renderCondensed(runOf('retry-target.ts'));

    // The first request settles without a translation, so the label holds the
    // count alone: the untranslated summary must not appear.
    await advance(BATCH_WINDOW_SETTLE_MS);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(textWithContent(renderer.root, '3 items')).toHaveLength(1);
    expect(texts(renderer).some(text => text.includes('retry-target.ts'))).toBe(false);

    // The row re-asks and the label resolves: a single gateway failure must not
    // strand the summary for the rest of the mount.
    await advance(RETRY_WINDOW_MS);
    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(textWithContent(renderer.root, '3 items; Nouveau fichier')).toHaveLength(1);
    renderer.unmount();
  });

  it('keeps the localized summary and makes no request when the last summary is not translatable', () => {
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderCondensed([
      makePart('t1', 'read', { filePath: '/repo/app.ts' }),
      makePart('t2', 'todoread'),
    ]);

    expect(textWithContent(renderer.root, '2 items; Read todos')).toHaveLength(1);
    expect(requestMock).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
