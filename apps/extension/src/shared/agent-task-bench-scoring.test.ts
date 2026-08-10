import { describe, expect, it } from 'vitest';
import type { BenchEvent } from './agent-workflow-bench-scoring';
import type { BenchTaskScenario } from './agent-task-bench-scenarios';
import { TASK_BENCH_SCENARIOS } from './agent-task-bench-scenarios';
import {
  computeTaskBatchSummary,
  scoreTaskCorrectness,
  selectFinalAnswer,
  TASK_SPEED_LIMIT_SECONDS,
} from './agent-task-bench-scoring';

const scenario = (overrides: Partial<BenchTaskScenario> = {}): BenchTaskScenario => ({
  answerChecks: [{ key: 'fact', re: /room 3327/iu, requireToolEvidence: true }],
  id: 'test-task',
  kind: 'task',
  message: 'Where did he die?',
  minAnswerChars: 10,
  mode: 'safe',
  requiresAction: false,
  startUrl: 'https://example.com/page',
  tabLabelRe: /example/iu,
  useCase: 'page-qa',
  ...overrides,
});

const answerEvent = (text: string): BenchEvent => ({
  id: 'message-1',
  role: 'assistant',
  text,
  type: 'message',
});

const toolExchange = (name: string, value: unknown, ok = true): BenchEvent[] => [
  { arguments: {}, id: `call-${name}`, name, type: 'tool-call' },
  { id: `result-${name}`, ok, toolCallId: `call-${name}`, type: 'tool-result', value },
];

describe('final answer selection', () => {
  it('returns the last non-empty assistant message', () => {
    const events: BenchEvent[] = [
      { id: 'message-0', role: 'user', text: 'question', type: 'message' },
      answerEvent('first answer'),
      answerEvent('final answer'),
      { id: 'message-3', role: 'assistant', text: '   ', type: 'message' },
    ];
    expect(selectFinalAnswer(events)).toBe('final answer');
  });

  it('returns an empty string when no assistant message exists', () => {
    expect(
      selectFinalAnswer([{ id: 'message-0', role: 'user', text: 'hi', type: 'message' }])
    ).toBe('');
  });
});

describe('task correctness scoring', () => {
  it('passes when the answer and tool evidence carry the pinned fact', () => {
    const events: BenchEvent[] = [
      ...toolExchange('find_in_page', { excerpt: 'died in room 3327 of the hotel' }),
      answerEvent('He died in room 3327 of the Hotel New Yorker.'),
    ];
    const result = scoreTaskCorrectness({ events, scenario: scenario() });
    expect(result.passed).toBe(true);
  });

  it('fails when the fact never appears in an ok tool result', () => {
    const events: BenchEvent[] = [answerEvent('He died in room 3327 of the Hotel New Yorker.')];
    const result = scoreTaskCorrectness({ events, scenario: scenario() });
    expect(result.passed).toBe(false);
    expect(result.predicates['toolEvidence']?.pass).toBe(false);
  });

  it('ignores evidence from failed tool results', () => {
    const events: BenchEvent[] = [
      ...toolExchange('find_in_page', { excerpt: 'room 3327' }, false),
      answerEvent('He died in room 3327 of the Hotel New Yorker.'),
    ];
    expect(scoreTaskCorrectness({ events, scenario: scenario() }).passed).toBe(false);
  });

  it('fails a short answer', () => {
    const events: BenchEvent[] = [
      ...toolExchange('find_in_page', { excerpt: 'room 3327' }),
      answerEvent('room 3327'),
    ];
    const result = scoreTaskCorrectness({
      events,
      scenario: scenario({ minAnswerChars: 50 }),
    });
    expect(result.passed).toBe(false);
    expect(result.predicates['answerLength']?.pass).toBe(false);
  });

  it('fails when a content check misses the answer', () => {
    const events: BenchEvent[] = [
      ...toolExchange('find_in_page', { excerpt: 'room 3327' }),
      answerEvent('He died in a New York hotel.'),
    ];
    const result = scoreTaskCorrectness({ events, scenario: scenario() });
    expect(result.passed).toBe(false);
    expect(result.predicates['answerContent']?.pass).toBe(false);
  });

  it('requires an ok eval exchange for action scenarios', () => {
    const actionScenario = scenario({
      answerChecks: [{ key: 'count', re: /6/u }],
      requiresAction: true,
    });
    const withoutAction = scoreTaskCorrectness({
      events: [answerEvent('There are 6 products listed.')],
      scenario: actionScenario,
    });
    expect(withoutAction.passed).toBe(false);
    expect(withoutAction.predicates['actionPerformed']?.pass).toBe(false);

    const withAction = scoreTaskCorrectness({
      events: [...toolExchange('eval', { count: 6 }), answerEvent('There are 6 products listed.')],
      scenario: actionScenario,
    });
    expect(withAction.passed).toBe(true);
  });
});

const stats = (turnTotalSeconds: number | null) => ({
  createToSavedSeconds: null,
  llmCreateRequestCount: 1,
  llmRequestCount: 1,
  readCallsBeforeFirstSave: 0,
  success: true,
  toolCallCount: 1,
  toolErrorCount: 0,
  turnTotalSeconds,
});

describe('task batch summary', () => {
  it('gates on the task turn total, not on save timing', () => {
    const summary = computeTaskBatchSummary([stats(30), stats(TASK_SPEED_LIMIT_SECONDS - 1)]);
    expect(summary.speedGatePassed).toBe(true);
    expect(summary.successCount).toBe(2);
  });

  it('fails the gate on a slow or missing turn total', () => {
    expect(computeTaskBatchSummary([stats(TASK_SPEED_LIMIT_SECONDS)]).speedGatePassed).toBe(false);
    expect(computeTaskBatchSummary([stats(null)]).speedGatePassed).toBe(false);
    expect(computeTaskBatchSummary([]).speedGatePassed).toBe(false);
  });
});

describe('task scenario registry', () => {
  it('keys match scenario ids and evidence checks exist where hallucination is possible', () => {
    for (const [key, entry] of Object.entries(TASK_BENCH_SCENARIOS)) {
      expect(entry.id).toBe(key);
      expect(entry.answerChecks.length).toBeGreaterThan(0);
      expect(entry.minAnswerChars).toBeGreaterThan(0);
    }
  });
});
