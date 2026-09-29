import { afterEach, describe, expect, it } from 'vitest';

import { buildActiveAgentsCardModel } from '@/components/home/active-agents-card-model';
import { type ActiveSession } from '@/lib/hooks/use-agent-sessions';
import {
  __resetSessionAttentionForTests,
  ackSessionAttention,
  isAttentionAcked,
  reconcileSessionAttention,
} from '@/lib/session-attention';

function needsInputSession(id: string): ActiveSession {
  return {
    id,
    status: 'question',
    statusUpdatedAt: '2026-09-27T10:00:00Z',
    title: id,
    connectionId: 'c1',
  };
}

function runningSession(id: string): ActiveSession {
  return {
    id,
    status: 'busy',
    statusUpdatedAt: '2026-09-27T10:00:00Z',
    title: id,
    connectionId: 'c1',
  };
}

afterEach(() => {
  __resetSessionAttentionForTests();
});

describe('buildActiveAgentsCardModel primary count', () => {
  it('skips a zero needs-input row and ranks the running count as primary', () => {
    const model = buildActiveAgentsCardModel([runningSession('s1')]);

    expect(model.countLines.find(line => line.kind === 'needsInput')?.count).toBe(0);
    expect(model.countLines.find(line => line.kind === 'running')?.count).toBe(1);
    expect(model.primaryCountKind).toBe('running');
  });

  it('ranks a real needs-input wait above the running count', () => {
    const model = buildActiveAgentsCardModel([runningSession('s1'), needsInputSession('s2')]);

    expect(model.primaryCountKind).toBe('needsInput');
  });

  it('has no primary line when every count is zero', () => {
    expect(buildActiveAgentsCardModel([]).primaryCountKind).toBeNull();
  });
});

describe('buildActiveAgentsCardModel answered raises', () => {
  it('counts an answered raise as idle but keeps its server status for the row', () => {
    const answered = needsInputSession('s1');
    ackSessionAttention('s1');

    const model = buildActiveAgentsCardModel([answered]);

    expect(model.countLines.find(line => line.kind === 'needsInput')?.count).toBe(0);
    expect(model.relevantSession?.id).toBe('s1');
    expect(model.relevantSession?.status).toBe('question');
  });

  it('keeps the ack after the relevant row reconciles with its raw status', () => {
    const answered = needsInputSession('s1');
    ackSessionAttention('s1');

    const relevant = buildActiveAgentsCardModel([answered]).relevantSession;
    expect(relevant).not.toBeNull();
    if (!relevant) {
      return;
    }
    reconcileSessionAttention(relevant.id, relevant.status, null);

    expect(isAttentionAcked('s1', 'question')).toBe(true);
    expect(
      buildActiveAgentsCardModel([answered]).countLines.find(line => line.kind === 'needsInput')
        ?.count
    ).toBe(0);
  });
});
