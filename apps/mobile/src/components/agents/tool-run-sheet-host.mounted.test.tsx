import { type Part, type StoredMessage, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { useOpenToolRun } from './open-tool-run-context';
import { ToolRunSheetHost } from './tool-run-sheet-host';

// The host mounts the run sheet, whose react-native imports cannot load in this
// DOM-free node project. The host's own resolution logic never touches it.
vi.mock('./tool-run-sheet', () => ({ ToolRunSheet: 'ToolRunSheet' }));

function makeCompletedToolPart(id: string, tool = 'bash'): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: `msg-${id}`,
    type: 'tool',
    callID: `call-${id}`,
    tool,
    state: {
      status: 'completed',
      input: { command: 'echo hi' },
      output: '',
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

/** A tool call still streaming: the open sheet must track this part as it resolves. */
function makeRunningToolPart(id: string): ToolPart {
  return {
    id,
    sessionID: 's1',
    messageID: `msg-${id}`,
    type: 'tool',
    callID: `call-${id}`,
    tool: 'bash',
    state: {
      status: 'running',
      input: { command: 'echo hi' },
      time: { start: 1 },
    },
  };
}

type CountingMessages = { messages: StoredMessage[]; partReads: () => number };

// `indexPartsById` iterates every message's parts. A getter counts those reads
// so a case can prove the closed host never builds an index it will not use.
function makeCountingMessages(parts: Part[]): CountingMessages {
  let reads = 0;
  const message = {
    info: {
      id: `msg-${parts[0]?.id ?? 'empty'}`,
      sessionID: 's1',
      role: 'assistant',
      time: { created: 1 },
      agent: 'test',
      model: { providerID: 'kilo', modelID: 'claude-sonnet-4' },
    },
    get parts() {
      reads += 1;
      return parts;
    },
  } as unknown as StoredMessage;
  return { messages: [message], partReads: () => reads };
}

type Opener = { current: ((parts: readonly ToolPart[]) => void) | null };

function hostElement(opener: Opener, messages: readonly StoredMessage[]) {
  function OpenerComponent() {
    opener.current = useOpenToolRun();
    return null;
  }
  return (
    <ToolRunSheetHost messages={messages}>
      <OpenerComponent />
    </ToolRunSheetHost>
  );
}

function mountHost(opener: Opener, messages: readonly StoredMessage[]) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  TestRenderer.act(() => {
    ref.current = TestRenderer.create(hostElement(opener, messages));
  });
  if (!ref.current) {
    throw new Error('host did not mount');
  }
  return ref.current;
}

describe('ToolRunSheetHost part index', () => {
  it('does not index parts while the run sheet is closed', () => {
    const opener: Opener = { current: null };
    const first = makeCountingMessages([makeRunningToolPart('t1')]);
    const renderer = mountHost(opener, first.messages);

    expect(first.partReads()).toBe(0);
    expect(renderer.root.findByType('ToolRunSheet').props.visible).toBe(false);

    // A streaming publish hands the host a rebuilt messages array; a closed host
    // must not pay for an index no open sheet will read.
    const second = makeCountingMessages([makeRunningToolPart('t1')]);
    TestRenderer.act(() => {
      renderer.update(hostElement(opener, second.messages));
    });
    expect(second.partReads()).toBe(0);

    renderer.unmount();
  });

  it('indexes the live parts once while open and tracks a streamed rebuild', () => {
    const opener: Opener = { current: null };
    const running = makeRunningToolPart('t1');
    const first = makeCountingMessages([running]);
    const renderer = mountHost(opener, first.messages);

    TestRenderer.act(() => {
      opener.current?.([running]);
    });

    expect(renderer.root.findByType('ToolRunSheet').props).toMatchObject({
      visible: true,
      parts: [running],
    });
    expect(first.partReads()).toBeGreaterThanOrEqual(1);

    // The next publish resolves the completed part through the rebuilt index.
    const resolved = makeCompletedToolPart('t1');
    const second = makeCountingMessages([resolved]);
    TestRenderer.act(() => {
      renderer.update(hostElement(opener, second.messages));
    });
    expect(renderer.root.findByType('ToolRunSheet').props).toMatchObject({
      visible: true,
      parts: [resolved],
    });
    expect(second.partReads()).toBeGreaterThanOrEqual(1);

    renderer.unmount();
  });
});
