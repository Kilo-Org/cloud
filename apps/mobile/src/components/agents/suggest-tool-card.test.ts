import { type StandaloneSuggestion, type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import type * as ReactI18next from 'react-i18next';

import {
  SuggestToolCard as renderSuggestToolCard,
  SuggestToolCardBody as renderSuggestToolCardBody,
} from './suggest-tool-card';
import { FixedPartRow } from './fixed-part-row';
import { MonoScrollBlock } from './mono-scroll-block';
import { SuggestionCard } from './suggestion-card';
import { GenericToolCardBody } from './tool-cards/generic-tool-card';
import { SelectableText } from '@/components/ui/selectable-text';

const { state, manager, openPartDetail } = vi.hoisted(() => ({
  state: { activeSuggestion: null as StandaloneSuggestion | null },
  manager: {
    atoms: { activeSuggestion: {} },
    acceptSuggestion: vi.fn<() => Promise<void>>(),
    dismissSuggestion: vi.fn<() => Promise<void>>(),
  },
  openPartDetail: vi.fn(),
}));

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('react-i18next', async importOriginal => ({
  ...(await importOriginal<typeof ReactI18next>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('./mono-scroll-block', () => ({ MonoScrollBlock: 'MonoScrollBlock' }));
vi.mock('./suggestion-card', () => ({ SuggestionCard: 'SuggestionCard' }));
vi.mock('./tool-cards/generic-tool-card', () => ({ GenericToolCardBody: 'GenericToolCardBody' }));
vi.mock('./open-part-detail-context', () => ({ useOpenPartDetail: () => openPartDetail }));
vi.mock('@/components/ui/selectable-text', () => ({ SelectableText: 'SelectableText' }));
vi.mock('@/components/ui/icons', () => ({ Sparkles: 'Sparkles' }));
vi.mock('jotai', () => ({ useAtomValue: () => state.activeSuggestion }));
vi.mock('@/components/agents/session-provider', () => ({ useSessionManager: () => manager }));

const actions = [
  { label: 'Review', description: 'Review the uncommitted changes', prompt: '/review' },
  { label: 'Test', description: 'Run the focused tests', prompt: 'Run the session tests.' },
];
const input = { suggest: 'Choose the next step.\nReview the changes before continuing.', actions };

function makeSuggestPart(status: ToolPart['state']['status']): ToolPart {
  const base = {
    id: 'suggest-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool' as const,
    callID: 'call-1',
    tool: 'suggest',
  };
  if (status === 'pending') {
    return { ...base, state: { status, input, raw: '' } };
  }
  if (status === 'running') {
    return { ...base, state: { status, input, time: { start: 0 } } };
  }
  if (status === 'error') {
    return {
      ...base,
      state: { status, input, error: 'Request failed', time: { start: 0, end: 1 } },
    };
  }
  return {
    ...base,
    state: {
      status,
      input,
      output:
        'User accepted the suggestion "Review". Carry out the following request now:\n\nReview the changes.',
      title: 'User accepted: Review',
      metadata: { accepted: actions[0], dismissed: false, truncated: false },
      time: { start: 0, end: 1 },
    },
  };
}

function findAll(
  node: unknown,
  type: React.ElementType
): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    return node.flatMap(child => findAll(child, type));
  }
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return [];
  }
  const matches = node.type === type ? [node] : [];
  return [...matches, ...findAll(node.props.children, type)];
}

function rowProps(part: ToolPart) {
  const row = renderSuggestToolCard({ part });
  expect(row.type).toBe(FixedPartRow);
  return row.props as React.ComponentProps<typeof FixedPartRow>;
}

beforeEach(() => {
  state.activeSuggestion = null;
  vi.clearAllMocks();
  manager.acceptSuggestion.mockResolvedValue();
  manager.dismissSuggestion.mockResolvedValue();
});

describe('SuggestToolCard', () => {
  it.each(['pending', 'running', 'completed', 'error'] as const)(
    'opens details for %s without taking an action',
    status => {
      const part = makeSuggestPart(status);
      const row = rowProps(part);
      expect(row.label).toBe(status === 'error' ? 'Suggestion dismissed' : input.suggest);
      row.onPress?.();
      expect(openPartDetail).toHaveBeenCalledWith(part.id);
      expect(manager.acceptSuggestion).not.toHaveBeenCalled();
      expect(manager.dismissSuggestion).not.toHaveBeenCalled();
    }
  );

  it('opens the active suggestion before tool input arrives', () => {
    state.activeSuggestion = { requestId: 'req-1', callId: 'call-1', text: input.suggest, actions };
    const part = makeSuggestPart('running');
    part.state.input = {};
    const row = rowProps(part);
    expect(row.label).toBe(input.suggest);
    row.onPress?.();
    expect(openPartDetail).toHaveBeenCalledWith(part.id);
  });

  it('does not open an empty pending suggestion', () => {
    const part = makeSuggestPart('pending');
    part.state.input = {};
    expect(rowProps(part).onPress).toBeUndefined();
  });
});

describe('SuggestToolCardBody', () => {
  it('shows complete historical suggestion text, actions, prompts, and output', () => {
    const part = makeSuggestPart('completed');
    const body = renderSuggestToolCardBody({ part });
    expect(findAll(body, SelectableText).map(node => node.props.children)).toEqual([
      input.suggest,
      actions[0]?.label,
      actions[0]?.description,
      actions[1]?.label,
      actions[1]?.description,
    ]);
    expect(findAll(body, MonoScrollBlock).map(node => node.props.content)).toEqual([
      '/review',
      'Run the session tests.',
      part.state.status === 'completed' ? part.state.output : '',
    ]);
    expect(findAll(body, SuggestionCard)).toHaveLength(0);
  });

  it('shows active request details without duplicating the composer action controls', () => {
    state.activeSuggestion = { requestId: 'req-1', callId: 'call-1', text: input.suggest, actions };
    const part = makeSuggestPart('running');
    part.state.input = {};
    const body = renderSuggestToolCardBody({ part });
    expect(findAll(body, SelectableText).map(node => node.props.children)).toEqual([
      input.suggest,
      actions[0]?.label,
      actions[0]?.description,
      actions[1]?.label,
      actions[1]?.description,
    ]);
    expect(findAll(body, SuggestionCard)).toHaveLength(0);
    expect(manager.acceptSuggestion).not.toHaveBeenCalled();
    expect(manager.dismissSuggestion).not.toHaveBeenCalled();
  });

  it.each(['completed', 'error', 'running'] as const)(
    'does not bind unrelated active actions to a %s tool',
    status => {
      state.activeSuggestion = {
        requestId: 'req-other',
        callId: 'other-call',
        text: 'Other request',
        actions,
      };
      expect(
        findAll(renderSuggestToolCardBody({ part: makeSuggestPart(status) }), SuggestionCard)
      ).toHaveLength(0);
    }
  );

  it('shows the actual error text', () => {
    const body = renderSuggestToolCardBody({ part: makeSuggestPart('error') });
    expect(findAll(body, SelectableText).map(node => node.props.children)).toContain(
      'Request failed'
    );
  });

  it('keeps a completed dismissal inspectable', () => {
    const part = makeSuggestPart('completed');
    if (part.state.status !== 'completed') {
      throw new Error('Expected a completed part');
    }
    part.state.metadata = { dismissed: true, truncated: false };
    part.state.output = 'User dismissed the suggestion.';
    expect(rowProps(part).label).toBe('Suggestion dismissed');
    const body = renderSuggestToolCardBody({ part });
    expect(findAll(body, MonoScrollBlock).map(node => node.props.content)).toContain(
      part.state.output
    );
  });

  it.each([
    {},
    { suggest: 42, actions },
    { suggest: 'Legacy input', actions: [{ label: 'Missing prompt' }] },
  ])('falls back to raw details for malformed input %j', malformed => {
    const part = makeSuggestPart('completed');
    part.state.input = malformed;
    expect(renderSuggestToolCardBody({ part }).type).toBe(GenericToolCardBody);
  });
});
