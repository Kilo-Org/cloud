import { type ToolPart } from '@kilocode/cloud-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

import { SuggestToolCard } from './suggest-tool-card';

const { resolveSuggestionPresentation, manager, activeSuggestion } = vi.hoisted(() => {
  const suggestion = {
    requestId: 'req-1',
    callId: 'call-1',
    text: 'Suggestion text',
    actions: [{ label: 'Apply', description: 'Apply this change' }],
  };
  return {
    resolveSuggestionPresentation: vi.fn(),
    manager: {
      atoms: { activeSuggestion: {} },
      acceptSuggestion: vi.fn(),
      dismissSuggestion: vi.fn(),
    },
    activeSuggestion: suggestion,
  };
});

vi.mock('./suggestion-card-state', () => ({ resolveSuggestionPresentation }));
vi.mock('./suggestion-card', () => ({ SuggestionCard: 'SuggestionCard' }));
vi.mock('./fixed-part-row', () => ({ FixedPartRow: 'FixedPartRow' }));
vi.mock('lucide-react-native', () => ({ Sparkles: 'Sparkles' }));
vi.mock('jotai', () => ({ useAtomValue: () => activeSuggestion }));
vi.mock('@/components/agents/session-provider', () => ({
  useSessionManager: () => manager,
}));

function makeSuggestState(status: ToolPart['state']['status']): ToolPart['state'] {
  if (status === 'pending') {
    return { status: 'pending', input: {}, raw: '' };
  }
  if (status === 'running') {
    return { status: 'running', input: {}, time: { start: 0 } };
  }
  if (status === 'error') {
    return { status: 'error', input: {}, error: 'dismissed', time: { start: 0, end: 1 } };
  }
  return {
    status: 'completed',
    input: {},
    output: '',
    title: '',
    metadata: {},
    time: { start: 0, end: 1 },
  };
}

function makeSuggestPart(status: ToolPart['state']['status']): ToolPart {
  return {
    id: 'suggest-1',
    sessionID: 'session-1',
    messageID: 'message-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'suggest',
    state: makeSuggestState(status),
  };
}

function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];
  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      const props = value.props as Record<string, unknown>;
      if (typeof value.type === 'function') {
        walk((value.type as React.FunctionComponent<unknown>)(props));
      }
      walk(props.children);
    }
  }
  walk(node);
  return matches;
}

function findByType(root: React.ReactElement, type: string): React.ReactElement[] {
  return findAll(root, el => el.type === type);
}

describe('SuggestToolCard — interactive suggestion stays in the list', () => {
  beforeEach(() => {
    resolveSuggestionPresentation.mockReset();
    manager.acceptSuggestion.mockReset();
    manager.dismissSuggestion.mockReset();
  });

  it('renders SuggestionCard with accept/dismiss wired to the manager', async () => {
    resolveSuggestionPresentation.mockReturnValue('interactive');
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = SuggestToolCard({
      part: makeSuggestPart('running'),
    }) as unknown as React.ReactElement;

    const cards = findByType(root, 'SuggestionCard');
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (!card) {
      throw new Error('card not found');
    }
    const cardProps = card.props as {
      text: string;
      actions: unknown;
      onAccept: (index: number) => Promise<void>;
      onDismiss: () => Promise<void>;
    };
    expect(cardProps).toMatchObject({
      text: 'Suggestion text',
      actions: [{ label: 'Apply', description: 'Apply this change' }],
    });

    await cardProps.onAccept(1);
    expect(manager.acceptSuggestion).toHaveBeenCalledWith('req-1', 1);

    await cardProps.onDismiss();
    expect(manager.dismissSuggestion).toHaveBeenCalledWith('req-1');
  });

  it('never renders a fixed row in the interactive presentation', () => {
    resolveSuggestionPresentation.mockReturnValue('interactive');
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = SuggestToolCard({
      part: makeSuggestPart('running'),
    }) as unknown as React.ReactElement;
    expect(findByType(root, 'FixedPartRow')).toHaveLength(0);
  });
});

describe('SuggestToolCard — compact fixed row', () => {
  beforeEach(() => {
    resolveSuggestionPresentation.mockReset();
  });

  it('renders a disabled fixed row for a pending suggestion', () => {
    resolveSuggestionPresentation.mockReturnValue('compact');
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = SuggestToolCard({
      part: makeSuggestPart('pending'),
    }) as unknown as React.ReactElement;

    const rows = findByType(root, 'FixedPartRow');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) {
      throw new Error('row not found');
    }
    const rowProps = row.props as {
      icon: string;
      label: string;
      status: string;
      accessibilityLabel: string;
      onPress?: unknown;
    };
    expect(rowProps).toMatchObject({
      icon: 'Sparkles',
      label: 'Suggestion',
      status: 'pending',
      accessibilityLabel: 'Suggestion tool, pending',
    });
    expect(rowProps.onPress).toBeUndefined();
  });

  it('uses the plain label for a completed suggestion', () => {
    resolveSuggestionPresentation.mockReturnValue('compact');
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = SuggestToolCard({
      part: makeSuggestPart('completed'),
    }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    const rowProps = row.props as { label: string; accessibilityLabel: string };
    expect(rowProps.label).toBe('Suggestion');
    expect(rowProps.accessibilityLabel).toBe('Suggestion tool, completed');
  });

  it('uses the dismissed label for an error suggestion', () => {
    resolveSuggestionPresentation.mockReturnValue('compact');
    // eslint-disable-next-line new-cap, react-compiler-runtime/react-compiler-runtime -- direct function call
    const root = SuggestToolCard({
      part: makeSuggestPart('error'),
    }) as unknown as React.ReactElement;
    const row = findByType(root, 'FixedPartRow')[0];
    if (!row) {
      throw new Error('row not found');
    }
    const rowProps = row.props as { label: string; status: string; accessibilityLabel: string };
    expect(rowProps.label).toBe('Suggestion dismissed');
    expect(rowProps.status).toBe('error');
    expect(rowProps.accessibilityLabel).toBe('Suggestion dismissed tool, error');
  });
});
