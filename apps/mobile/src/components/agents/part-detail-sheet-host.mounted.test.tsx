/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import {
  type Part,
  type ReasoningPart,
  type StoredMessage,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { useOpenPartDetail } from './open-part-detail-context';
import { PartDetailSheetHost } from './part-detail-sheet-host';

vi.mock('react-native', () => ({
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock('@/components/sheet-header', () => ({
  SheetHeader: 'SheetHeader',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('./tool-part-detail-body', () => ({
  ToolPartDetailBody: 'ToolPartDetailBody',
}));

let capturedOpener: ((partId: string) => void) | null = null;
function Opener() {
  capturedOpener = useOpenPartDetail();
  return null;
}

function makeBashPart(id: string, command: string, completed = false): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'tool',
    callID: `call-${id}`,
    tool: 'bash',
    state: completed
      ? {
          status: 'completed',
          input: { command },
          output: 'done',
          title: 'bash',
          metadata: {},
          time: { start: 1, end: 2 },
        }
      : { status: 'running', input: { command }, time: { start: 1 } },
  };
}

function makeReasoningPart(id: string, text: string, ended = true): ReasoningPart {
  return {
    id,
    sessionID: 's1',
    messageID: 'm1',
    type: 'reasoning',
    text,
    time: { start: 1, end: ended ? 2 : undefined },
  };
}

function makeMessage(id: string, parts: Part[]): StoredMessage {
  return {
    info: {
      id,
      sessionID: 's1',
      role: 'user',
      time: { created: 1 },
      agent: 'test',
      model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
    },
    parts,
  };
}

function hostElement(messages: StoredMessage[]): ReactElement {
  return (
    <PartDetailSheetHost messages={messages}>
      <Opener />
    </PartDetailSheetHost>
  );
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- react-test-renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

function sheetTitle(renderer: TestRenderer.ReactTestRenderer): unknown {
  return propOf(findByType(renderer.root, 'SheetHeader')[0], 'title');
}

async function mountHost(messages: StoredMessage[]): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(hostElement(messages));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('PartDetailSheetHost mounted', () => {
  it('opens a tool part and updates content live without close/reopen', async () => {
    const renderer = await mountHost([makeMessage('m1', [makeBashPart('bash-1', 'echo one')])]);

    expect(capturedOpener).toBeTypeOf('function');

    await act(async () => {
      await Promise.resolve();
      capturedOpener?.('bash-1');
    });

    expect(propOf(findByType(renderer.root, 'Modal')[0], 'visible')).toBe(true);
    expect(propOf(findByType(renderer.root, 'Modal')[0], 'presentationStyle')).toBe('pageSheet');
    expect(sheetTitle(renderer)).toBe('bash: echo one');
    const openedPart = propOf(findByType(renderer.root, 'ToolPartDetailBody')[0], 'part');
    expect((openedPart as ToolPart).id).toBe('bash-1');

    // A stream tick replaces the part object in the messages array. The host
    // re-resolves the same id from the live prop on every render.
    await act(async () => {
      await Promise.resolve();
      renderer.update(hostElement([makeMessage('m1', [makeBashPart('bash-1', 'echo two', true)])]));
    });

    // Still open, no close/reopen: the sheet reflects the refreshed part.
    expect(propOf(findByType(renderer.root, 'Modal')[0], 'visible')).toBe(true);
    expect(sheetTitle(renderer)).toBe('bash: echo two');
    const refreshedPart = propOf(findByType(renderer.root, 'ToolPartDetailBody')[0], 'part');
    expect((refreshedPart as ToolPart).state.status).toBe('completed');
  });

  it('shows Details unavailable when the open part id does not resolve', async () => {
    const renderer = await mountHost([makeMessage('m1', [makeBashPart('bash-1', 'echo one')])]);

    await act(async () => {
      await Promise.resolve();
      capturedOpener?.('ghost');
    });

    expect(sheetTitle(renderer)).toBe('Details');
    const unavailable = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        propOf(node, 'children') === 'Details unavailable'
    );
    expect(unavailable).toHaveLength(1);
  });

  it('renders full selectable reasoning text with the completed label', async () => {
    const renderer = await mountHost([
      makeMessage('m1', [makeReasoningPart('r1', 'working through it', true)]),
    ]);

    await act(async () => {
      await Promise.resolve();
      capturedOpener?.('r1');
    });

    expect(sheetTitle(renderer)).toBe('Thought');
    const reasoningTexts = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Text' &&
        propOf(node, 'children') === 'working through it' &&
        propOf(node, 'selectable') === true
    );
    expect(reasoningTexts).toHaveLength(1);
  });
});
