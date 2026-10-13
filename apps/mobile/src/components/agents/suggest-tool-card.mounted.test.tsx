import {
  type SessionManager,
  type StandaloneSuggestion,
  type ToolPart,
} from '@kilocode/cloud-agent-sdk';
import { atom, createStore, Provider as JotaiProvider } from 'jotai';
import { type ReactElement } from 'react';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionManagerContext } from './session-manager-context';
import { SuggestToolCard, SuggestToolCardBody } from './suggest-tool-card';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('./fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('./mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('./tool-cards/generic-tool-card', () => ({ GenericToolCardBody: 'GenericToolCardBody' }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('@/components/ui/icons', () => ({ Sparkles: 'Sparkles' }));

const actions = [{ label: 'Review', description: 'Review the changes', prompt: '/review' }];
const activeSuggestion: StandaloneSuggestion = {
  requestId: 'req-1',
  callId: 'call-1',
  text: 'Active request text',
  actions,
};
// Test fixture: the card reads only the active-suggestion atom.
const liveSessionManager = {
  atoms: { activeSuggestion: atom<StandaloneSuggestion | null>(activeSuggestion) },
} as unknown as SessionManager;
const liveSessionStore = createStore();

function makeRunningSuggestPart(): ToolPart {
  return {
    id: 'suggest-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'suggest',
    state: {
      status: 'running',
      input: { suggest: 'Tool input text', actions },
      time: { start: 0 },
    },
  };
}

let renderer: ReactTestRenderer | null = null;

function render(element: ReactElement): ReactTestRenderer {
  act(() => {
    renderer = TestRenderer.create(element);
  });
  if (renderer === null) {
    throw new Error('Expected a renderer');
  }
  return renderer;
}

function withLiveSession(element: ReactElement): ReactElement {
  return (
    <JotaiProvider store={liveSessionStore}>
      <SessionManagerContext.Provider value={liveSessionManager}>
        {element}
      </SessionManagerContext.Provider>
    </JotaiProvider>
  );
}

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
});

describe('SuggestToolCard without a session provider', () => {
  it('renders the row from the tool input', () => {
    const tree = render(<SuggestToolCard part={makeRunningSuggestPart()} />);
    expect(tree.root.findByType('FixedPartRow').props.label).toBe('Tool input text');
  });

  it('renders the detail body from the tool input', () => {
    const tree = render(<SuggestToolCardBody part={makeRunningSuggestPart()} />);
    expect(tree.root.findAllByType('SelectableText').map(node => node.props.children)).toEqual([
      'Tool input text',
      'Review',
      'Review the changes',
    ]);
  });
});

describe('SuggestToolCard with a live session', () => {
  it('renders the active suggestion in the row and the detail body', () => {
    const row = render(withLiveSession(<SuggestToolCard part={makeRunningSuggestPart()} />));
    expect(row.root.findByType('FixedPartRow').props.label).toBe('Active request text');
    act(() => {
      row.update(withLiveSession(<SuggestToolCardBody part={makeRunningSuggestPart()} />));
    });
    expect(row.root.findAllByType('SelectableText').map(node => node.props.children)).toEqual([
      'Active request text',
      'Review',
      'Review the changes',
    ]);
  });
});
