import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearToolSummaryTranslationMemory,
  setConfig,
} from '@/lib/tool-summary-translation/tool-summary-translation-runtime';

import { type MobileSlashCommandInfo } from './chat-composer-slash-commands';
import { SlashCommandSuggestions } from './slash-command-suggestions';

const { requestMock, readMock, writeMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
  readMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock('@/lib/tool-summary-translation/tool-summary-translation-client', () => ({
  requestToolSummaryTranslations: requestMock,
}));
// The encrypted-KV cache is a native module, loaded by the runtime's dynamic
// import; mock it the same way as the client so this suite stays native-free.
vi.mock('@/lib/persist/tool-summary-translation-cache', () => ({
  readToolSummaryTranslations: readMock,
  writeToolSummaryTranslation: writeMock,
}));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
// `cn` lives beside the app's i18n instance; mocking it keeps this suite free
// of the real catalogue, matching how the other mounted suites isolate it.
vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'de' } }),
}));

const MODEL = { id: 'kilo-auto/small', name: 'Auto Small' };

const REVIEW: MobileSlashCommandInfo = {
  name: 'review',
  description: 'Review the diff',
  hints: [],
  source: 'command',
};
const MCP_TOOL: MobileSlashCommandInfo = {
  name: 'mcp-tool',
  description: 'Run the MCP tool',
  hints: [],
  source: 'mcp',
};
const SKILL_TOOL: MobileSlashCommandInfo = {
  name: 'skill-tool',
  description: 'Run the skill',
  hints: [],
  source: 'skill',
};
const LOCAL_NEW: MobileSlashCommandInfo = {
  name: 'new',
  description: 'Start a new session',
  hints: [],
  catalogueDescription: true,
};
const NO_DESCRIPTION: MobileSlashCommandInfo = { name: 'bare', hints: [] };

function findHost(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

/** The description line of every row: the one Text that carries `mt-0.5`. */
function descriptionLines(root: TestRenderer.ReactTestInstance): string[] {
  return findHost(root, 'Text')
    .filter(
      node => typeof node.props.className === 'string' && node.props.className.includes('mt-0.5')
    )
    .map(node => node.props.children as string);
}

/**
 * Sync-commit mount so the pre-resolution render is observable: the dynamic
 * import cannot resolve inside a synchronous `act`, which is exactly the
 * source-description-first state.
 */
function renderSuggestionsSync(commands: MobileSlashCommandInfo[]): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(
      createElement(SlashCommandSuggestions, { commands, onSelect: () => undefined })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

async function settleTranslation(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop -- real time for the batch window, then the macrotask that settles the dynamic import and request
      await new Promise<void>(resolve => {
        setTimeout(resolve, 20);
      });
    }
  });
}

beforeEach(() => {
  requestMock.mockReset();
  readMock.mockReset();
  writeMock.mockReset();
  readMock.mockResolvedValue([]);
  writeMock.mockResolvedValue(undefined);
  clearToolSummaryTranslationMemory();
  setConfig({ enabled: false, model: MODEL });
});

describe('SlashCommandSuggestions translation', () => {
  it('translates runtime (MCP and skill) descriptions in place when enabled', async () => {
    requestMock.mockImplementation(
      // eslint-disable-next-line typescript-eslint/require-await -- the mock answers the batch synchronously
      async ({ texts }: { texts: readonly string[] }) => texts.map(text => `de:${text}`)
    );
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderSuggestionsSync([REVIEW, MCP_TOOL, SKILL_TOOL]);

    // Uncached: the source description renders first, then swaps in place.
    expect(descriptionLines(renderer.root)).toEqual([
      'Review the diff',
      'Run the MCP tool',
      'Run the skill',
    ]);
    await settleTranslation();

    expect(descriptionLines(renderer.root)).toEqual([
      'de:Review the diff',
      'de:Run the MCP tool',
      'de:Run the skill',
    ]);
    // The runtime key space is disjoint from tool-part ids.
    await vi.waitFor(() => {
      expect(writeMock).toHaveBeenCalled();
    });
    const writtenIds = writeMock.mock.calls.map(call => (call[0] as { itemId: string }).itemId);
    expect(writtenIds).toContain('slash-command:mcp-tool');
    expect(writtenIds).toContain('slash-command:skill-tool');
    act(() => {
      renderer.unmount();
    });
  });

  it('does not translate or request a catalogue description', async () => {
    requestMock.mockResolvedValue(['de:Start a new session']);
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderSuggestionsSync([LOCAL_NEW]);

    await settleTranslation();

    expect(descriptionLines(renderer.root)).toEqual(['Start a new session']);
    expect(requestMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps every description and makes no request when the feature is off', async () => {
    requestMock.mockResolvedValue(['de:Run the MCP tool']);
    setConfig({ enabled: false, model: MODEL });
    const renderer = renderSuggestionsSync([MCP_TOOL, SKILL_TOOL]);

    await settleTranslation();

    expect(descriptionLines(renderer.root)).toEqual(['Run the MCP tool', 'Run the skill']);
    expect(requestMock).not.toHaveBeenCalled();
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the source description when the translation request rejects', async () => {
    requestMock.mockRejectedValue(new Error('gateway down'));
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderSuggestionsSync([MCP_TOOL]);

    await settleTranslation();

    expect(descriptionLines(renderer.root)).toEqual(['Run the MCP tool']);
    act(() => {
      renderer.unmount();
    });
  });

  it('keeps the source description for a null batch entry', async () => {
    requestMock.mockResolvedValue([null]);
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderSuggestionsSync([MCP_TOOL]);

    await settleTranslation();

    expect(descriptionLines(renderer.root)).toEqual(['Run the MCP tool']);
    act(() => {
      renderer.unmount();
    });
  });

  it('renders no description line for a description-less command', () => {
    setConfig({ enabled: true, model: MODEL });
    const renderer = renderSuggestionsSync([NO_DESCRIPTION]);

    expect(descriptionLines(renderer.root)).toEqual([]);
    act(() => {
      renderer.unmount();
    });
  });

  it('renders null when there are no commands', () => {
    const renderer = renderSuggestionsSync([]);

    expect(renderer.toJSON()).toBeNull();
    act(() => {
      renderer.unmount();
    });
  });
});
