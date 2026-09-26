import '@/i18n';
import { createElement } from 'react';
import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { MockTextInput } from '@/test/native-input.test-helpers';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { GenericToolCardBody } from './generic-tool-card';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  TextInput: MockTextInput,
  View: 'View',
}));
// `SelectableText` calls `useContext(TextClassContext)`, so the module needs a
// real context even though the renderer is a string element.
vi.mock('@/components/ui/text', async () => {
  const React = await import('react');
  return {
    Text: 'Text',
    TextClassContext: React.createContext<string | undefined>(undefined),
  };
});
vi.mock('@/components/ui/icons', () => ({ Plug: 'Plug' }));
// RNGH ships Flow source the node project cannot parse; the field rows are what
// this suite renders, so the output block is a string element.
vi.mock('../mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
// The card module's row chrome and display projection pull the motion policy
// (expo-battery) and the attachment models, neither of which this body suite
// exercises.
vi.mock('../fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('../tool-card-display', () => ({ getToolDisplay: vi.fn(), toolPartHasDetails: vi.fn() }));

type Renderer = TestRenderer.ReactTestRenderer;

function makeQuestionPart(): ToolPart {
  return {
    id: 'question-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'question',
    state: {
      status: 'completed',
      input: {
        questions: [
          {
            header: 'E2E',
            question: 'Which fields should the sheet show?',
            options: [{ label: 'Continue', description: 'Continue the E2E scenario' }],
          },
        ],
      },
      output: '',
      title: '',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function makeMcpErrorPart(): ToolPart {
  return {
    id: 'mcp-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-2',
    tool: 'mcp',
    state: {
      status: 'error',
      input: {
        server_name: 'linear',
        tool_name: 'create_issue',
        arguments: { title: 'Fix the sheet', team: 'ENG' },
      },
      error: 'boom',
      time: { start: 0, end: 1 },
    },
  };
}

function makeEmptyUnknownPart(): ToolPart {
  return {
    id: 'unknown-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-3',
    tool: 'unknown-tool',
    state: {
      status: 'completed',
      input: {},
      output: '',
      title: '',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

function makeBlankErrorPart(): ToolPart {
  return {
    id: 'error-blank-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-5',
    tool: 'unknown-tool',
    state: {
      status: 'error',
      input: {},
      error: '',
      time: { start: 0, end: 1 },
    },
  };
}

function makeParameterlessMcpPart(): ToolPart {
  return {
    id: 'mcp-empty-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-4',
    tool: 'mcp',
    state: {
      status: 'completed',
      input: { server_name: 'linear', tool_name: 'list_teams', arguments: {} },
      output: '',
      title: '',
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

async function renderBody(part: ToolPart): Promise<Renderer> {
  const holder: { current?: Renderer } = {};
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(createElement(GenericToolCardBody, { part }));
  });
  const renderer = holder.current;
  if (renderer === undefined) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

/** Every visible string: `Text` children and read-only `TextInput` values. */
function textValues(root: TestRenderer.ReactTestInstance): string[] {
  const labels = findByType(root, 'Text')
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string');
  const values = findByType(root, 'TextInput')
    .map(node => node.props.value)
    .filter((value): value is string => typeof value === 'string');
  return [...labels, ...values];
}

describe('GenericToolCardBody mounted', () => {
  it('renders labelled question rows and never dumps the raw input JSON', async () => {
    const renderer = await renderBody(makeQuestionPart());

    const values = textValues(renderer.root);
    expect(values).toContain('header');
    expect(values).toContain('E2E');
    expect(values).toContain('question');
    expect(values).toContain('Which fields should the sheet show?');
    expect(values).toContain('options');
    expect(values).toContain('Continue — Continue the E2E scenario');
    expect(values.some(value => value.includes('"questions"'))).toBe(false);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders the unwrapped mcp arguments and the error with no retry affordance', async () => {
    const renderer = await renderBody(makeMcpErrorPart());

    const values = textValues(renderer.root);
    expect(values).toContain('title');
    expect(values).toContain('Fix the sheet');
    expect(values).toContain('team');
    expect(values).toContain('ENG');
    expect(values).toContain('boom');
    // A failed tool call is retried by the agent, so the sheet offers no
    // user-triggered retry control.
    expect(findByType(renderer.root, 'Pressable')).toHaveLength(0);
    expect(findByType(renderer.root, 'Button')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('renders the muted empty state for an empty unknown part instead of a blank sheet', async () => {
    const renderer = await renderBody(makeEmptyUnknownPart());

    expect(findByType(renderer.root, 'View').length).toBeGreaterThan(0);
    // No field labels and no mono block, but the body is not blank: the muted
    // empty line keeps the sheet from opening as an empty region.
    expect(findByType(renderer.root, 'Text')).toHaveLength(0);
    expect(findByType(renderer.root, 'MonoScrollBlock')).toHaveLength(0);
    expect(textValues(renderer.root)).toEqual(['No output.']);

    act(() => {
      renderer.unmount();
    });
  });

  it('leaves the empty state to the dispatcher status line while a part is running', async () => {
    const running: ToolPart = {
      ...makeEmptyUnknownPart(),
      state: { status: 'running', input: {}, time: { start: 0 } },
    };
    const renderer = await renderBody(running);

    // The dispatcher's `Running…` line is the visible state; the body must not
    // stack a second one on top of it.
    expect(textValues(renderer.root)).toEqual([]);

    act(() => {
      renderer.unmount();
    });
  });

  it('shows a failure line for an errored part with a blank message', async () => {
    const renderer = await renderBody(makeBlankErrorPart());

    // The status, not the message, drives the failure line: a blank message
    // must not fall through to the success-looking `No output.` empty state.
    const values = textValues(renderer.root);
    expect(values).toEqual(['Failed']);
    expect(values).not.toContain('No output.');

    act(() => {
      renderer.unmount();
    });
  });

  it('renders the raw envelope for a parameterless mcp call instead of a blank sheet', async () => {
    const renderer = await renderBody(makeParameterlessMcpPart());

    const values = textValues(renderer.root);
    expect(values).toContain('server_name');
    expect(values).toContain('linear');
    expect(values).toContain('tool_name');
    expect(values).toContain('list_teams');
    expect(values).toContain('arguments');
    expect(values).toContain('{}');

    act(() => {
      renderer.unmount();
    });
  });
});
