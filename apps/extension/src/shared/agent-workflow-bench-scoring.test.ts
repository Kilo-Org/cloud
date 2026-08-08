/* eslint-disable max-lines -- Comprehensive coverage of every pinned scorer contract branch. */
import { describe, expect, it } from 'vitest';
import {
  BENCH_SPEED_LIMIT_SECONDS,
  computeBatchSummary,
  correlateToolExchanges,
  scoreWorkflowCorrectness,
} from './agent-workflow-bench-scoring';
import type {
  BenchAttemptStats,
  BenchEvent,
  BenchFollowUp,
  BenchWorkflow,
} from './agent-workflow-bench-scoring';

const scenarioWorkflow = (overrides: Partial<BenchWorkflow> = {}): BenchWorkflow => ({
  approvedScriptHash: 'approved-hash-1234',
  description: 'Business class one way flight search',
  id: 'wf-flights',
  name: 'Flights search',
  params: [
    { description: 'The destination city to fly to', name: 'destination' },
    { description: 'The departure date', name: 'date' },
  ],
  pathPrefix: '/travel/flights',
  scopeOrigin: 'https://www.google.com',
  script: 'const business = true; // business class one way flights search',
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
  pagesVisited: 1,
  result: {
    flights: [{ airline: 'Lufthansa', date: '2026-09-21', price: '€ 245', route: 'Paris' }],
  },
  workflowName: 'Flights search',
};

const realRunEvents = (resultValue: unknown): BenchEvent[] => [
  toolCall('call-save', 'save_workflow', { name: 'Flights search', workflowId: 'wf-flights' }),
  toolResult('call-save', true, { saved: true, workflowId: 'wf-flights' }),
  toolCall('call-run', 'run_workflow', {
    input: { date: '2026-09-21', destination: 'Paris' },
    workflowId: 'wf-flights',
  }),
  toolResult('call-run', true, resultValue),
];

const dryRunEvents = (input: Record<string, unknown>, actions: unknown): BenchEvent[] => [
  toolCall('call-dry', 'run_workflow', { dryRun: true, input, workflowId: 'wf-flights' }),
  toolResult('call-dry', true, {
    dryRun: true,
    dryRunActions: actions,
    pagesVisited: 1,
    result: { dryRun: true, note: 'recorded actions' },
    workflowName: 'Flights search',
  }),
];

const attempt = (overrides: Partial<BenchAttemptStats>): BenchAttemptStats => ({
  createToSavedSeconds: 120,
  llmCreateRequestCount: 5,
  llmRequestCount: 6,
  readCallsBeforeFirstSave: 2,
  success: true,
  toolCallCount: 7,
  toolErrorCount: 1,
  turnTotalSeconds: 130,
  ...overrides,
});

describe('scoreWorkflowCorrectness stored-workflow predicates', () => {
  it('passes every stored predicate and the real-run result check', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [scenarioWorkflow()],
    });

    const storedKeys = [
      'approvedScriptHash',
      'pathPrefix',
      'scopeOrigin',
      'scriptBusiness',
      'scriptOneWay',
      'storedWorkflow',
      'workflowParams',
    ] as const;

    expect(result.resultCheck).toBe('real');
    expect(result.passed).toBe(true);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(true);
    expect(storedKeys.every(key => result.predicates[key]?.pass === true)).toBe(true);
  });

  it('reports no stored workflow', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [],
    });

    expect(result.predicates['storedWorkflow']?.pass).toBe(false);
    expect(result.predicates['storedWorkflow']?.detail).toBe('no workflow stored');
    expect(result.passed).toBe(false);
  });

  it('fails the scope origin predicate on a mismatched origin', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [scenarioWorkflow({ scopeOrigin: 'https://www.bing.com' })],
    });

    expect(result.predicates['scopeOrigin']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails the path prefix predicate on a mismatched prefix', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [scenarioWorkflow({ pathPrefix: '/search' })],
    });

    expect(result.predicates['pathPrefix']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails the approved hash predicate when the hash is empty', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [scenarioWorkflow({ approvedScriptHash: '' })],
    });

    expect(result.predicates['approvedScriptHash']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails the params predicate when the date param is missing', () => {
    const workflow = scenarioWorkflow({
      params: [{ description: 'The destination city to fly to', name: 'destination' }],
    });
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [workflow],
    });

    expect(result.predicates['workflowParams']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails the business marker predicate when the script lacks it', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [scenarioWorkflow({ script: 'return { done: true, result: {} };' })],
    });

    expect(result.predicates['scriptBusiness']?.pass).toBe(false);
    expect(result.predicates['scriptOneWay']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails the one-way marker predicate when the script lacks it', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents(parisResultValue),
      workflows: [scenarioWorkflow({ script: 'const business = true; // return flights' })],
    });

    expect(result.predicates['scriptOneWay']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('scoreWorkflowCorrectness real-run result check', () => {
  it('fails when the destination is missing from the result', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents({
        pagesVisited: 1,
        result: {
          flights: [{ airline: 'Lufthansa', date: '2026-09-21', price: '€ 245', route: 'Nice' }],
        },
        workflowName: 'Flights search',
      }),
      workflows: [scenarioWorkflow()],
    });

    expect(result.resultCheck).toBe('real');
    expect(result.predicates['resultHasDestination']?.pass).toBe(false);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails when the date is missing from the result', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents({
        pagesVisited: 1,
        result: { flights: [{ airline: 'Lufthansa', price: '€ 245', route: 'Paris' }] },
        workflowName: 'Flights search',
      }),
      workflows: [scenarioWorkflow()],
    });

    expect(result.predicates['resultHasDate']?.pass).toBe(false);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails when the result carries no price digits or currency', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents({
        pagesVisited: 1,
        result: { flights: [{ airline: 'Lufthansa', route: 'Paris' }] },
        workflowName: 'Flights search',
      }),
      workflows: [scenarioWorkflow()],
    });

    expect(result.predicates['resultHasPrice']?.pass).toBe(false);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails the price predicate on a date-only result', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents({
        pagesVisited: 1,
        result: {
          flights: [{ airline: 'Lufthansa', date: '2026-09-21', route: 'Paris' }],
        },
        workflowName: 'Flights search',
      }),
      workflows: [scenarioWorkflow()],
    });

    // A loose `$`-anchored currency regex would match the digit-carrying date.
    // Only a literal currency plus a digit may pass the price predicate.
    expect(result.predicates['resultHasDate']?.pass).toBe(true);
    expect(result.predicates['resultHasPrice']?.pass).toBe(false);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails when the result carries no carrier', () => {
    const result = scoreWorkflowCorrectness({
      events: realRunEvents({
        pagesVisited: 1,
        result: { flights: [{ date: '2026-09-21', price: '€ 245', route: 'Paris' }] },
        workflowName: 'Flights search',
      }),
      workflows: [scenarioWorkflow()],
    });

    expect(result.predicates['resultHasCarrier']?.pass).toBe(false);
    expect(result.predicates['resultHasDestination']?.pass).toBe(true);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('scoreWorkflowCorrectness real-run selection', () => {
  it('selects the last ok real run with non-empty input', () => {
    const events: BenchEvent[] = [
      toolCall('call-save', 'save_workflow', { name: 'Flights search', workflowId: 'wf-flights' }),
      toolResult('call-save', true, { saved: true, workflowId: 'wf-flights' }),
      // An ok real run for Nice comes first.
      toolCall('call-run-nice', 'run_workflow', {
        input: { date: '2026-08-01', destination: 'Nice' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run-nice', true, {
        pagesVisited: 1,
        result: {
          flights: [{ airline: 'Lufthansa', date: '2026-08-01', price: '€ 180', route: 'Nice' }],
        },
        workflowName: 'Flights search',
      }),
      // A dry run is not a real run.
      toolCall('call-dry', 'run_workflow', {
        dryRun: true,
        input: { date: '2026-08-02', destination: 'Rome' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-dry', true, {
        dryRun: true,
        dryRunActions: [{ action: 'fill', selector: 'input[name="destination"]' }],
        pagesVisited: 1,
        result: { dryRun: true },
        workflowName: 'Flights search',
      }),
      // An ok real run with empty input does not count.
      toolCall('call-run-empty', 'run_workflow', { input: {}, workflowId: 'wf-flights' }),
      toolResult('call-run-empty', true, {
        pagesVisited: 1,
        result: { flights: [] },
        workflowName: 'Flights search',
      }),
      // A failed real run does not count.
      toolCall('call-run-rome', 'run_workflow', {
        input: { date: '2026-07-15', destination: 'Rome' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run-rome', false),
      // The last ok real run wins: Paris.
      toolCall('call-run-paris', 'run_workflow', {
        input: { date: '2026-09-21', destination: 'Paris' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run-paris', true, parisResultValue),
    ];

    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    // Only the Paris run carries the expected destination; a wrong selection would fail.
    expect(result.resultCheck).toBe('real');
    expect(result.predicates['resultHasDestination']?.pass).toBe(true);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('extracts the destination by param-name match and the date by ISO regex', () => {
    const events: BenchEvent[] = [
      toolCall('call-run', 'run_workflow', {
        input: { date: '21.09.2026', destination: 'Paris', travelDate: '2026-09-21' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run', true, parisResultValue),
    ];

    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    expect(result.resultCheck).toBe('real');
    expect(result.predicates['resultHasDestination']?.pass).toBe(true);
    expect(result.predicates['resultHasDate']?.pass).toBe(true);
  });

  it('extracts the destination from the input value echoed in the result', () => {
    const events: BenchEvent[] = [
      toolCall('call-run', 'run_workflow', {
        input: { from: 'Belgrade', to: 'Paris' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run', true, {
        pagesVisited: 1,
        result: {
          flights: [{ airline: 'Lufthansa', date: '2026-09-21', price: '€ 245', route: 'Paris' }],
        },
        workflowName: 'Flights search',
      }),
    ];

    // No destination-ish param name; the date is missing from the input, so no check can run.
    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    expect(result.resultCheck).toBe('none');
    expect(result.passed).toBe(false);
  });

  it('extracts the destination via the echoed-result fallback when the param name does not match', () => {
    const events: BenchEvent[] = [
      toolCall('call-run', 'run_workflow', {
        input: { from: 'Belgrade', to: 'Paris', travelDate: '2026-09-21' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run', true, {
        pagesVisited: 1,
        result: {
          flights: [{ airline: 'Lufthansa', date: '2026-09-21', price: '€ 245', route: 'Paris' }],
        },
        workflowName: 'Flights search',
      }),
    ];

    // No input key matches the workflow's `destination` param.
    // The fallback selects the input value echoed in the result; the ISO date still binds.
    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    expect(result.resultCheck).toBe('real');
    expect(result.predicates['resultHasDestination']?.pass).toBe(true);
    expect(result.predicates['resultHasDate']?.pass).toBe(true);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('reports none when expected values cannot be extracted from the input', () => {
    const events: BenchEvent[] = [
      toolCall('call-run', 'run_workflow', {
        input: { destination: 'Paris' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run', true, parisResultValue),
    ];

    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    expect(result.resultCheck).toBe('none');
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('prefers the follow-up destination and date over extracted values', () => {
    const followUp: BenchFollowUp = { date: '2026-09-21', destination: 'Paris' };
    const events: BenchEvent[] = [
      toolCall('call-run', 'run_workflow', {
        input: { date: '2026-08-01', destination: 'Berlin' },
        workflowId: 'wf-flights',
      }),
      toolResult('call-run', true, parisResultValue),
    ];

    const result = scoreWorkflowCorrectness({
      events,
      followUp,
      workflows: [scenarioWorkflow()],
    });

    // The result carries Paris, not Berlin, so only the follow-up values pass.
    expect(result.resultCheck).toBe('real');
    expect(result.predicates['resultHasDestination']?.pass).toBe(true);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(true);
  });
});

describe('scoreWorkflowCorrectness dry-run fallback', () => {
  it('passes when input binds the params and the actions are sufficient', () => {
    const result = scoreWorkflowCorrectness({
      events: dryRunEvents({ date: '2026-09-21', destination: 'Paris' }, [
        { action: 'fill', selector: 'input[name="destination"]' },
        { action: 'click', selector: 'input[name="departureDate"]' },
      ]),
      workflows: [scenarioWorkflow()],
    });

    expect(result.resultCheck).toBe('dry-run');
    expect(result.predicates['dryRunInput']?.pass).toBe(true);
    expect(result.predicates['dryRunActions']?.pass).toBe(true);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails when the dry-run input does not bind the expected destination', () => {
    const followUp: BenchFollowUp = { date: '2026-09-21', destination: 'Paris' };
    const result = scoreWorkflowCorrectness({
      events: dryRunEvents({ date: '2026-09-21', destination: 'Rome' }, [
        { action: 'fill', selector: 'input[name="destination"]' },
        { action: 'click', selector: 'input[name="departureDate"]' },
      ]),
      followUp,
      workflows: [scenarioWorkflow()],
    });

    expect(result.resultCheck).toBe('dry-run');
    expect(result.predicates['dryRunInput']?.pass).toBe(false);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('fails when the dry-run actions are insufficient', () => {
    const result = scoreWorkflowCorrectness({
      events: dryRunEvents({ date: '2026-09-21', destination: 'Paris' }, [
        { action: 'fill', selector: 'input[name="destination"]' },
      ]),
      workflows: [scenarioWorkflow()],
    });

    expect(result.predicates['dryRunInput']?.pass).toBe(true);
    expect(result.predicates['dryRunActions']?.pass).toBe(false);
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('prefers a real run over the dry-run fallback', () => {
    const events: BenchEvent[] = [
      ...dryRunEvents({ date: '2026-09-21', destination: 'Paris' }, [
        { action: 'fill', selector: 'input[name="destination"]' },
        { action: 'click', selector: 'input[name="departureDate"]' },
      ]),
      ...realRunEvents(parisResultValue),
    ];

    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    expect(result.resultCheck).toBe('real');
    expect(result.predicates['dryRunInput']).toBeUndefined();
    expect(result.passed).toBe(true);
  });
});

describe('scoreWorkflowCorrectness toolCallId correlation', () => {
  it('classes unmatched tool-results as unknown-tool and keeps them out of exchanges', () => {
    const events: BenchEvent[] = [
      ...realRunEvents(parisResultValue),
      // A tool-result whose tool-call is absent stays an unknown-tool marker.
      toolResult('call-ghost', true, parisResultValue),
    ];

    const correlation = correlateToolExchanges(events);
    expect(correlation.exchanges).toHaveLength(2);

    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    expect(result.resultCheck).toBe('real');
    expect(result.predicates['runWorkflowResult']?.pass).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('reports none when the only run evidence is an unmatched tool-result', () => {
    const events: BenchEvent[] = [toolResult('call-ghost', true, parisResultValue)];

    const correlation = correlateToolExchanges(events);
    expect(correlation.exchanges).toHaveLength(0);

    const result = scoreWorkflowCorrectness({ events, workflows: [scenarioWorkflow()] });

    expect(result.resultCheck).toBe('none');
    expect(result.predicates['runWorkflowResult']?.pass).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe('batch summary aggregation', () => {
  it('computes the median and max over non-null samples with an odd count', () => {
    const summary = computeBatchSummary([
      attempt({ createToSavedSeconds: 100 }),
      attempt({ createToSavedSeconds: 200 }),
      attempt({ createToSavedSeconds: 300 }),
    ]);

    expect(summary.attempts).toBe(3);
    expect(summary.medians.createToSavedSeconds).toBe(200);
    expect(summary.maxCreateToSavedSeconds).toBe(300);
    expect(summary.successCount).toBe(3);
  });

  it('averages the two middle samples for an even count', () => {
    const summary = computeBatchSummary([
      attempt({ createToSavedSeconds: 100 }),
      attempt({ createToSavedSeconds: 200 }),
      attempt({ createToSavedSeconds: 300 }),
      attempt({ createToSavedSeconds: 400 }),
    ]);

    expect(summary.medians.createToSavedSeconds).toBe(250);
    expect(summary.maxCreateToSavedSeconds).toBe(400);
  });

  it('skips null samples and counts only successes', () => {
    const summary = computeBatchSummary([
      attempt({ createToSavedSeconds: null, success: false }),
      attempt({ createToSavedSeconds: 100, success: true }),
      attempt({ createToSavedSeconds: 200, success: true }),
    ]);

    expect(summary.medians.createToSavedSeconds).toBe(150);
    expect(summary.maxCreateToSavedSeconds).toBe(200);
    expect(summary.successCount).toBe(2);
  });

  it('reports null medians for an all-null metric', () => {
    const summary = computeBatchSummary([
      attempt({ createToSavedSeconds: null, turnTotalSeconds: null }),
      attempt({ createToSavedSeconds: null, turnTotalSeconds: null }),
    ]);

    expect(summary.medians.createToSavedSeconds).toBeNull();
    expect(summary.medians.turnTotalSeconds).toBeNull();
    expect(summary.maxCreateToSavedSeconds).toBeNull();
  });

  it('passes the speed gate strictly below the limit', () => {
    const summary = computeBatchSummary([
      attempt({ createToSavedSeconds: BENCH_SPEED_LIMIT_SECONDS - 0.001 }),
      attempt({ createToSavedSeconds: 100 }),
    ]);

    expect(summary.speedGatePassed).toBe(true);
  });

  it('fails the speed gate at the limit boundary', () => {
    const summary = computeBatchSummary([
      attempt({ createToSavedSeconds: BENCH_SPEED_LIMIT_SECONDS }),
      attempt({ createToSavedSeconds: 100 }),
    ]);

    expect(summary.speedGatePassed).toBe(false);
  });

  it('fails the speed gate when any attempt has no measured time', () => {
    const summary = computeBatchSummary([
      attempt({ createToSavedSeconds: null }),
      attempt({ createToSavedSeconds: 100 }),
    ]);

    expect(summary.speedGatePassed).toBe(false);
  });
});
