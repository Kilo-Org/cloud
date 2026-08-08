/* eslint-disable max-lines, unicorn/consistent-function-scoping -- Comprehensive coverage of the scenario-driven scorer contract. */
import { describe, expect, it } from 'vitest';
import {
  BENCH_SPEED_LIMIT_SECONDS,
  computeBatchSummary,
  correlateToolExchanges,
  scoreWorkflowCorrectness,
  selectLastValidRealRun,
} from './agent-workflow-bench-scoring';
import type { BenchAttemptStats, BenchEvent, BenchWorkflow } from './agent-workflow-bench-scoring';
import { BENCH_SCENARIOS, isoDateVariants } from './agent-workflow-bench-scenarios';

const { flights } = BENCH_SCENARIOS;
const { hn } = BENCH_SCENARIOS;
if (flights === undefined || hn === undefined) {
  throw new Error('scenario registry is missing flights or hn');
}

const flightsFollowUp = { date: '2026-09-21', destination: 'Paris' };

const flightsWorkflow = (overrides: Partial<BenchWorkflow> = {}): BenchWorkflow => ({
  approvedScriptHash: 'approved-hash-1234',
  description: 'Business class flight search',
  id: 'wf-flights',
  name: 'Flights search',
  params: [
    { description: 'The destination city to fly to', name: 'destination' },
    { description: 'The departure date', name: 'date' },
  ],
  pathPrefix: '/travel/flights',
  scopeOrigin: 'https://www.google.com',
  script: 'const url = "?q=business class flights"; return { navigate: url, state: {} }',
  ...overrides,
});

const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>
): Extract<BenchEvent, { type: 'tool-call' }> => ({
  arguments: args,
  id,
  name,
  type: 'tool-call',
});

const toolResult = (
  toolCallId: string,
  ok: boolean,
  value?: unknown
): Extract<BenchEvent, { type: 'tool-result' }> =>
  value === undefined
    ? { id: `res-${toolCallId}`, ok, toolCallId, type: 'tool-result' }
    : { id: `res-${toolCallId}`, ok, toolCallId, type: 'tool-result', value };

const parisResultValue = {
  pagesVisited: 2,
  result:
    'Flights to Paris · departing Sep 21 · Lufthansa · € 245 · nonstop · business class — top results from the flight search page, sorted by best.',
  workflowName: 'Flights search',
};

let runCallCounter = 0;
const runEvents = (input: Record<string, unknown>, resultValue: unknown, dryRun = false) => {
  runCallCounter += 1;
  const id = `call-run-${String(runCallCounter)}`;
  return [
    toolCall(id, 'run_workflow', {
      input,
      workflowId: 'wf-flights',
      ...(dryRun ? { dryRun: true } : {}),
    }),
    toolResult(id, true, resultValue),
  ];
};

describe('tool exchange correlation', () => {
  it('joins results to calls by toolCallId and drops orphan results', () => {
    const events: BenchEvent[] = [
      toolCall('call-1', 'run_workflow', {}),
      toolResult('call-1', true, { result: 'ok' }),
      toolResult('call-orphan', true, { result: 'orphan' }),
    ];

    const { exchanges } = correlateToolExchanges(events);

    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.call.id).toBe('call-1');
  });
});

describe('real-run selection', () => {
  it('skips dry runs, empty inputs, and failed results, and picks the last valid run', () => {
    const events: BenchEvent[] = [
      ...runEvents({ destination: 'Paris' }, { result: 'dry' }, true),
      toolCall('call-empty', 'run_workflow', { input: {}, workflowId: 'wf' }),
      toolResult('call-empty', true, { result: 'empty-input' }),
      toolCall('call-failed', 'run_workflow', { input: { destination: 'x' }, workflowId: 'wf' }),
      toolResult('call-failed', false),
      toolCall('call-a', 'run_workflow', { input: { destination: 'Paris' }, workflowId: 'wf' }),
      toolResult('call-a', true, { result: 'first' }),
      toolCall('call-b', 'run_workflow', { input: { destination: 'Paris' }, workflowId: 'wf' }),
      toolResult('call-b', true, { result: 'second' }),
    ];

    const run = selectLastValidRealRun(correlateToolExchanges(events).exchanges);

    expect(run?.call.id).toBe('call-b');
  });
});

describe('stored workflow predicates', () => {
  const passingEvents = runEvents(flightsFollowUp, parisResultValue);

  it('passes a fully correct flights attempt', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [flightsWorkflow({ script: 'business class ?q= flights search' })],
    });

    expect(result.passed).toBe(true);
    expect(result.resultCheck).toBe('real');
  });

  it('fails when no workflow is stored', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [],
    });

    expect(result.passed).toBe(false);
    expect(result.predicates['storedWorkflow']?.pass).toBe(false);
  });

  it('fails on a wrong scope origin', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [
        flightsWorkflow({
          scopeOrigin: 'https://example.com',
          script: 'business',
        }),
      ],
    });

    expect(result.predicates['scopeOrigin']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails when the pathPrefix excludes the scenario start URL', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [flightsWorkflow({ pathPrefix: '/maps', script: 'business' })],
    });

    expect(result.predicates['scopeCoversStartUrl']?.pass).toBe(false);
  });

  it('accepts an omitted pathPrefix', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [flightsWorkflow({ pathPrefix: undefined, script: 'business' })],
    });

    expect(result.predicates['scopeCoversStartUrl']?.pass).toBe(true);
  });

  it('fails without an approved script hash', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [flightsWorkflow({ approvedScriptHash: undefined, script: 'business' })],
    });

    expect(result.predicates['approvedScriptHash']?.pass).toBe(false);
  });

  it('fails when an expected param is missing', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [
        flightsWorkflow({
          params: [{ description: 'The destination city', name: 'destination' }],
          script: 'business',
        }),
      ],
    });

    expect(result.predicates['workflowParams']?.pass).toBe(false);
    expect(result.predicates['workflowParams']?.detail).toContain('date');
  });

  it('fails when a script marker is missing', () => {
    const result = scoreWorkflowCorrectness({
      events: passingEvents,
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows: [flightsWorkflow({ script: 'economy only' })],
    });

    expect(result.predicates['scriptMarkers']?.pass).toBe(false);
    expect(result.predicates['scriptMarkers']?.detail).toContain('business');
  });
});

describe('run evidence scoring', () => {
  const workflows = [flightsWorkflow({ script: 'business' })];

  it('fails when the run input misses a follow-up value', () => {
    const result = scoreWorkflowCorrectness({
      events: runEvents({ destination: 'Paris' }, parisResultValue),
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    expect(result.predicates['runInputBound']?.pass).toBe(false);
    expect(result.predicates['runInputBound']?.detail).toContain('date');
    expect(result.passed).toBe(false);
  });

  it('fails when the result misses a required content check', () => {
    const result = scoreWorkflowCorrectness({
      events: runEvents(flightsFollowUp, {
        result: 'Flights to Paris found many results with no numbers or airline names here',
      }),
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    expect(result.predicates['resultContent']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails when the result misses the destination value', () => {
    const result = scoreWorkflowCorrectness({
      events: runEvents(flightsFollowUp, {
        result: 'Lufthansa € 245 business class flight list without the city name',
      }),
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    expect(result.predicates['resultHasValues']?.pass).toBe(false);
  });

  it('fails a too-short result', () => {
    const result = scoreWorkflowCorrectness({
      events: runEvents(flightsFollowUp, { result: 'Paris €1 KL 123' }),
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    expect(result.predicates['resultLength']?.pass).toBe(false);
  });

  it('uses a valid dry run with real content when no real run exists', () => {
    const result = scoreWorkflowCorrectness({
      events: runEvents(flightsFollowUp, parisResultValue, true),
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    expect(result.resultCheck).toBe('dry-run');
    expect(result.passed).toBe(true);
  });

  it('prefers the real run over a dry run', () => {
    const result = scoreWorkflowCorrectness({
      events: [
        ...runEvents(flightsFollowUp, { result: 'dry note only' }, true),
        ...runEvents(flightsFollowUp, parisResultValue),
      ],
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    expect(result.resultCheck).toBe('real');
    expect(result.passed).toBe(true);
  });

  it('reports none without any valid run', () => {
    const result = scoreWorkflowCorrectness({
      events: [],
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    expect(result.resultCheck).toBe('none');
    expect(result.passed).toBe(false);
  });

  it('reports none without follow-up values', () => {
    const result = scoreWorkflowCorrectness({
      events: runEvents(flightsFollowUp, parisResultValue),
      followUpValues: undefined,
      scenario: flights,
      workflows,
    });

    expect(result.resultCheck).toBe('none');
    expect(result.passed).toBe(false);
  });

  it('matches an ISO follow-up date shown as a human date in the result', () => {
    const result = scoreWorkflowCorrectness({
      events: runEvents(flightsFollowUp, parisResultValue),
      followUpValues: flightsFollowUp,
      scenario: flights,
      workflows,
    });

    // The pinned result text says "Sep 21", never "2026-09-21".
    expect(result.predicates['resultHasValues']?.pass).toBe(true);
  });

  it('scores an hn attempt with topic-only params', () => {
    const result = scoreWorkflowCorrectness({
      events: [
        toolCall('call-run', 'run_workflow', { input: { topic: 'rust' }, workflowId: 'wf-hn' }),
        toolResult('call-run', true, {
          result:
            'Why Discord is switching from Go to Rust — 1205 points — 610 comments — and more rust stories from Hacker News search results',
        }),
      ],
      followUpValues: { topic: 'rust' },
      scenario: hn,
      workflows: [
        {
          approvedScriptHash: 'hash',
          description: 'HN topic search',
          id: 'wf-hn',
          name: 'HN search',
          params: [{ description: 'The topic to search for', name: 'topic' }],
          scopeOrigin: 'https://hn.algolia.com',
          script: 'return { navigate: "https://hn.algolia.com/?query=" + input.topic, state: {} }',
        },
      ],
    });

    expect(result.passed).toBe(true);
  });
});

describe('iso date variants', () => {
  it('renders human variants for an ISO date', () => {
    expect(isoDateVariants('2026-09-21')).toStrictEqual([
      '2026-09-21',
      'Sep 21',
      'September 21',
      '21 Sep',
      '21 September',
    ]);
  });

  it('returns a non-ISO value unchanged', () => {
    expect(isoDateVariants('Paris')).toStrictEqual(['Paris']);
  });
});

describe('batch summary', () => {
  const stats = (overrides: Partial<BenchAttemptStats>): BenchAttemptStats => ({
    createToSavedSeconds: 60,
    llmCreateRequestCount: 2,
    llmRequestCount: 3,
    readCallsBeforeFirstSave: 1,
    success: true,
    toolCallCount: 4,
    toolErrorCount: 0,
    turnTotalSeconds: 90,
    ...overrides,
  });

  it('aggregates medians, success count, and the speed gate', () => {
    const summary = computeBatchSummary([
      stats({ createToSavedSeconds: 30 }),
      stats({ createToSavedSeconds: 60 }),
      stats({ createToSavedSeconds: 90, success: false }),
    ]);

    expect(summary.attempts).toBe(3);
    expect(summary.successCount).toBe(2);
    expect(summary.medians.createToSavedSeconds).toBe(60);
    expect(summary.maxCreateToSavedSeconds).toBe(90);
    expect(summary.speedGatePassed).toBe(true);
  });

  it('fails the speed gate when any attempt is at or over the limit or never saved', () => {
    expect(
      computeBatchSummary([stats({ createToSavedSeconds: BENCH_SPEED_LIMIT_SECONDS })])
        .speedGatePassed
    ).toBe(false);
    expect(computeBatchSummary([stats({ createToSavedSeconds: null })]).speedGatePassed).toBe(
      false
    );
  });

  it('reports null medians for an empty batch', () => {
    const summary = computeBatchSummary([]);

    expect(summary.medians.createToSavedSeconds).toBeNull();
    expect(summary.maxCreateToSavedSeconds).toBeNull();
    expect(summary.successCount).toBe(0);
  });
});

describe('zero-param scenarios', () => {
  const { npr } = BENCH_SCENARIOS;
  if (npr === undefined) {
    throw new Error('scenario registry is missing npr');
  }

  const nprWorkflow: BenchWorkflow = {
    approvedScriptHash: 'hash',
    description: 'Top headlines',
    id: 'wf-npr',
    name: 'NPR headlines',
    scopeOrigin: 'https://text.npr.org',
    script: 'return { done: true, result: page.readText() };',
  };

  it('accepts a real run with no input when the scenario has no follow-up values', () => {
    const result = scoreWorkflowCorrectness({
      events: [
        toolCall('call-npr', 'run_workflow', { workflowId: 'wf-npr' }),
        toolResult('call-npr', true, {
          result: `NPR : National Public Radio — top news headlines for today. ${'Wildfires spread across the west; markets rally; new science findings released. '.repeat(3)}`,
        }),
      ],
      followUpValues: {},
      scenario: npr,
      workflows: [nprWorkflow],
    });

    expect(result.resultCheck).toBe('real');
    expect(result.passed).toBe(true);
  });

  it('still fails a zero-param scenario without any run', () => {
    const result = scoreWorkflowCorrectness({
      events: [],
      followUpValues: {},
      scenario: npr,
      workflows: [nprWorkflow],
    });

    expect(result.resultCheck).toBe('none');
    expect(result.passed).toBe(false);
  });
});

describe('scenario registry', () => {
  it('holds twenty scenarios with unique ids, origins matching start URLs', () => {
    const entries = Object.entries(BENCH_SCENARIOS);
    expect(entries).toHaveLength(20);
    for (const [key, scenario] of entries) {
      expect(scenario.id).toBe(key);
      expect(new URL(scenario.startUrl).origin).toBe(scenario.scopeOrigin);
      expect(scenario.followUpMessage.length).toBeGreaterThan(0);
      // Every followUpValues key referenced by the result checks exists.
      for (const valueKey of scenario.resultMustContainValues) {
        expect(Object.keys(scenario.followUpValues)).toContain(valueKey);
      }
    }
  });
});
