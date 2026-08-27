import { describe, expect, it } from '@jest/globals';
import type { Part, StepFinishPart, StoredMessage } from '@kilocode/cloud-agent-sdk';
import {
  formatSessionCost,
  getDisplayedSessionCostBreakdown,
  getSessionCostBreakdown,
  getSessionTotalCostUsd,
  isRenderableSessionCost,
} from './session-cost-breakdown';

function createAssistantMessage(
  cost: number,
  parts: Part[] = [],
  id = 'assistant-1'
): StoredMessage {
  return {
    info: {
      id,
      sessionID: 'session-1',
      role: 'assistant',
      time: { created: 1 },
      parentID: 'user-1',
      modelID: 'test-model',
      providerID: 'test-provider',
      mode: 'code',
      agent: 'test-agent',
      path: { cwd: '/', root: '/' },
      cost,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts,
  };
}

function createStepFinishPart(cost: number, id = 'step-1'): StepFinishPart {
  return {
    id,
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'step-finish',
    reason: 'stop',
    cost,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function createTaskToolPart(): Part {
  return {
    id: 'task-1',
    sessionID: 'session-1',
    messageID: 'assistant-1',
    type: 'tool',
    callID: 'call-1',
    tool: 'task',
    state: {
      status: 'completed',
      input: {},
      output: 'done',
      title: 'Subtask',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

describe('isRenderableSessionCost', () => {
  it.each([0.0000495, 0.00004999999999999, 0.00005, 0.00005000000000001, 0.01])(
    'accepts finite costs that round to at least 50 microdollars: %s',
    costUsd => {
      expect(isRenderableSessionCost(costUsd)).toBe(true);
    }
  );

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0.00005,
    0,
    0.0000494,
    0.00004949999999999,
  ])('rejects non-finite or subthreshold costs: %s', costUsd => {
    expect(isRenderableSessionCost(costUsd)).toBe(false);
  });
});

describe('formatSessionCost', () => {
  it.each([
    [0, '$0.0000'],
    [0.0000494, '$0.0000'],
    [0.0000495, '$0.0001'],
    [0.00005, '$0.0001'],
    [0.050049, '$0.0500'],
    [0.05005, '$0.0501'],
    [0.10005, '$0.1001'],
    [1.23455, '$1.2346'],
  ])('formats %s USD as %s using integer-microdollar half-up rounding', (costUsd, expected) => {
    expect(formatSessionCost(costUsd)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01])(
    'formats invalid or negative costs as zero: %s',
    costUsd => {
      expect(formatSessionCost(costUsd)).toBe('$0.0000');
    }
  );
});

describe('getDisplayedSessionCostBreakdown', () => {
  it('keeps half-unit root and subagent costs reconciled to the displayed total', () => {
    expect(
      getDisplayedSessionCostBreakdown({
        totalCostUsd: 0.0001,
        rootCostUsd: 0.00005,
        subagentCostUsd: 0.00005,
        olderActivityCostUsd: 0,
      })
    ).toEqual({
      totalCostUsd: 0.0001,
      rootCostUsd: 0,
      subagentCostUsd: 0.0001,
      olderActivityCostUsd: 0,
    });
  });

  it('limits rounded residual rows to the displayed total', () => {
    expect(
      getDisplayedSessionCostBreakdown({
        totalCostUsd: 0.0001,
        rootCostUsd: 0,
        subagentCostUsd: 0.00005,
        olderActivityCostUsd: 0.00005,
      })
    ).toEqual({
      totalCostUsd: 0.0001,
      rootCostUsd: 0,
      subagentCostUsd: 0.0001,
      olderActivityCostUsd: 0,
    });
  });

  it('preserves renderable components when enough display units are available', () => {
    const displayed = getDisplayedSessionCostBreakdown({
      totalCostUsd: 1.23456,
      rootCostUsd: 0.65432,
      subagentCostUsd: 0.34567,
      olderActivityCostUsd: 0.23457,
    });

    expect(displayed).toEqual({
      totalCostUsd: 1.2346,
      rootCostUsd: 0.6543,
      subagentCostUsd: 0.3457,
      olderActivityCostUsd: 0.2346,
    });
    expect(
      displayed.rootCostUsd + displayed.subagentCostUsd + displayed.olderActivityCostUsd
    ).toBeCloseTo(displayed.totalCostUsd, 12);
  });
});

describe('getSessionTotalCostUsd', () => {
  it('reconciles persisted and live totals without reading message history', () => {
    expect(getSessionTotalCostUsd(110_000, 0.07)).toBe(0.11);
    expect(getSessionTotalCostUsd(40_000, 0.07)).toBe(0.07);
    expect(getSessionTotalCostUsd(null, 0.1000005)).toBe(0.100001);
  });
});

describe('getSessionCostBreakdown', () => {
  it('returns zero costs when no messages or totals are available', () => {
    expect(getSessionCostBreakdown([], null, 0)).toEqual({
      totalCostUsd: 0,
      rootCostUsd: 0,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });
  });

  it('attributes root-only assistant work to its step-finish parts', () => {
    const messages: ReadonlyArray<StoredMessage> = [
      createAssistantMessage(0.03, [createStepFinishPart(0.01), createStepFinishPart(0.02)]),
    ];

    expect(getSessionCostBreakdown(messages, 30_000, 0.03)).toEqual({
      totalCostUsd: 0.03,
      rootCostUsd: 0.03,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });
  });

  it('attributes folded subagent work without adding assistant info cost twice', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.07, [createStepFinishPart(0.05)])],
      null,
      0.07
    );

    expect(result.totalCostUsd).toBe(0.07);
    expect(result.rootCostUsd).toBeCloseTo(0.05, 12);
    expect(result.subagentCostUsd).toBeCloseTo(0.02, 12);
    expect(result.olderActivityCostUsd).toBe(0);
    expect(result.rootCostUsd + result.subagentCostUsd).toBeCloseTo(result.totalCostUsd, 12);
  });

  it('attributes step-less task-wrapper costs to subagents', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.42, [createTaskToolPart()])],
      420_000,
      0.42
    );

    expect(result).toEqual({
      totalCostUsd: 0.42,
      rootCostUsd: 0,
      subagentCostUsd: 0.42,
      olderActivityCostUsd: 0,
    });
  });

  it('preserves root inference costs on task messages with completed steps', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.42, [createStepFinishPart(0.12), createTaskToolPart()])],
      420_000,
      0.42
    );

    expect(result.rootCostUsd).toBe(0.12);
    expect(result.subagentCostUsd).toBeCloseTo(0.3, 12);
  });

  it('keeps an exact 50-microdollar folded subagent residual renderable', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.10005, [createStepFinishPart(0.1)])],
      null,
      0.10005
    );

    expect(result.subagentCostUsd).toBeLessThan(0.00005);
    expect(result.subagentCostUsd).toBeCloseTo(0.00005, 12);
    expect(isRenderableSessionCost(result.subagentCostUsd)).toBe(true);
    expect(formatSessionCost(result.subagentCostUsd)).toBe('$0.0001');
  });

  it('combines multiple assistant messages and multiple root steps', () => {
    const messages = [
      createAssistantMessage(
        0.07,
        [createStepFinishPart(0.02), createStepFinishPart(0.03, 'step-2')],
        'assistant-1'
      ),
      createAssistantMessage(0.04, [createStepFinishPart(0.01, 'step-3')], 'assistant-2'),
      createAssistantMessage(0.02, [], 'assistant-3'),
    ];
    const result = getSessionCostBreakdown(messages, undefined, 0.13);

    expect(result.rootCostUsd).toBeCloseTo(0.08, 12);
    expect(result.subagentCostUsd).toBeCloseTo(0.05, 12);
    expect(result.totalCostUsd).toBe(0.13);
  });

  it('falls back to assistant info cost when step-finish parts are missing', () => {
    const textPart: Part = {
      id: 'text-1',
      sessionID: 'session-1',
      messageID: 'assistant-1',
      type: 'text',
      text: 'hello',
    };

    expect(getSessionCostBreakdown([createAssistantMessage(0.04, [textPart])], null, 0.04)).toEqual(
      {
        totalCostUsd: 0.04,
        rootCostUsd: 0.04,
        subagentCostUsd: 0,
        olderActivityCostUsd: 0,
      }
    );
  });

  it('falls back to assistant info cost when a step-finish part has no cost', () => {
    const stepFinishPart = createStepFinishPart(0.05);
    Reflect.deleteProperty(stepFinishPart, 'cost');

    expect(
      getSessionCostBreakdown([createAssistantMessage(0.05, [stepFinishPart])], null, 0.05)
    ).toEqual({
      totalCostUsd: 0.05,
      rootCostUsd: 0.05,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -0.01])(
    'falls back to assistant info cost when every step-finish cost is invalid: %s',
    stepCost => {
      const result = getSessionCostBreakdown(
        [createAssistantMessage(0.05, [createStepFinishPart(stepCost)])],
        null,
        0.05
      );

      expect(result.rootCostUsd).toBe(0.05);
      expect(result.subagentCostUsd).toBe(0);
    }
  );

  it('does not fall back to assistant info cost when a zero-cost step exists', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.07, [createStepFinishPart(0)])],
      null,
      0.07
    );

    expect(result.rootCostUsd).toBe(0);
    expect(result.subagentCostUsd).toBe(0.07);
  });

  it('reconciles a newer persisted total separately from folded subagent work', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.07, [createStepFinishPart(0.05)])],
      110_000,
      0.07
    );

    expect(result.totalCostUsd).toBe(0.11);
    expect(result.rootCostUsd).toBeCloseTo(0.05, 12);
    expect(result.subagentCostUsd).toBeCloseTo(0.02, 12);
    expect(result.olderActivityCostUsd).toBeCloseTo(0.04, 12);
    expect(result.rootCostUsd + result.subagentCostUsd + result.olderActivityCostUsd).toBeCloseTo(
      result.totalCostUsd,
      12
    );
  });

  it('keeps the newer live total when the persisted total is older', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.07, [createStepFinishPart(0.05)])],
      40_000,
      0.07
    );

    expect(result.totalCostUsd).toBe(0.07);
    expect(result.subagentCostUsd).toBeCloseTo(0.02, 12);
    expect(result.olderActivityCostUsd).toBe(0);
  });

  it('does not create older activity when persisted and live totals agree', () => {
    const result = getSessionCostBreakdown([createAssistantMessage(0.05)], 50_000, 0.05);

    expect(result.totalCostUsd).toBe(0.05);
    expect(result.olderActivityCostUsd).toBe(0);
  });

  it('selects the larger display total after rounding live USD to integer microdollars', () => {
    expect(getSessionCostBreakdown([], null, 0.1000004).totalCostUsd).toBe(0.1);
    expect(getSessionCostBreakdown([], 100_000, 0.1000005).totalCostUsd).toBe(0.100001);
    expect(getSessionCostBreakdown([], 100_001, 0.1000004).totalCostUsd).toBe(0.100001);
  });

  it('retains unrounded live USD when calculating folded subagent residuals', () => {
    const result = getSessionCostBreakdown(
      [createAssistantMessage(0.1000004, [createStepFinishPart(0.0999988)])],
      null,
      0.1000004
    );

    expect(result.totalCostUsd).toBe(0.1);
    expect(result.rootCostUsd).toBe(0.0999988);
    expect(result.subagentCostUsd).toBeCloseTo(0.0000016, 12);
  });

  it.each([null, undefined])('uses the live total when the persisted total is %s', persisted => {
    expect(getSessionCostBreakdown([createAssistantMessage(0.05)], persisted, 0.05)).toEqual({
      totalCostUsd: 0.05,
      rootCostUsd: 0.05,
      subagentCostUsd: 0,
      olderActivityCostUsd: 0,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -50_000])(
    'ignores an invalid persisted total of %s',
    persisted => {
      const result = getSessionCostBreakdown([createAssistantMessage(0.05)], persisted, 0.05);

      expect(result.totalCostUsd).toBe(0.05);
      expect(result.olderActivityCostUsd).toBe(0);
    }
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.02])(
    'sanitizes an invalid live total of %s',
    liveTotalCostUsd => {
      expect(getSessionCostBreakdown([], 80_000, liveTotalCostUsd)).toEqual({
        totalCostUsd: 0.08,
        rootCostUsd: 0,
        subagentCostUsd: 0,
        olderActivityCostUsd: 0.08,
      });
    }
  );

  it('sanitizes invalid step-finish costs without using the assistant fallback', () => {
    const result = getSessionCostBreakdown(
      [
        createAssistantMessage(0.08, [
          createStepFinishPart(Number.NaN),
          createStepFinishPart(Number.POSITIVE_INFINITY),
          createStepFinishPart(-0.01),
          createStepFinishPart(0.02),
        ]),
      ],
      null,
      0.05
    );

    expect(result.rootCostUsd).toBe(0.02);
    expect(result.subagentCostUsd).toBeCloseTo(0.03, 12);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01])(
    'sanitizes an invalid assistant fallback cost of %s',
    assistantCost => {
      expect(getSessionCostBreakdown([createAssistantMessage(assistantCost)], null, 0)).toEqual({
        totalCostUsd: 0,
        rootCostUsd: 0,
        subagentCostUsd: 0,
        olderActivityCostUsd: 0,
      });
    }
  );

  it.each([0, 5e-7, 1e-6])('suppresses a subagent residual at or below epsilon: %s', residual => {
    const result = getSessionCostBreakdown([createAssistantMessage(0)], null, residual);

    expect(result.subagentCostUsd).toBe(0);
  });

  it('retains a subagent residual above epsilon', () => {
    const result = getSessionCostBreakdown([createAssistantMessage(0)], null, 1.1e-6);

    expect(result.subagentCostUsd).toBe(1.1e-6);
  });

  it('suppresses floating-point drift and negative subagent residuals', () => {
    const messages = [
      createAssistantMessage(0.3, [createStepFinishPart(0.1), createStepFinishPart(0.2)]),
    ];

    expect(getSessionCostBreakdown(messages, null, 0.3).subagentCostUsd).toBe(0);
    expect(getSessionCostBreakdown(messages, null, 0.3000000000000001).subagentCostUsd).toBe(0);
    expect(getSessionCostBreakdown(messages, null, 0.2).subagentCostUsd).toBe(0);
  });

  it.each([0.5, 1, 2, 49])(
    'suppresses older activity below the four-decimal rendering threshold: %s microdollars',
    persistedMicrodollars => {
      expect(getSessionCostBreakdown([], persistedMicrodollars, 0).olderActivityCostUsd).toBe(0);
    }
  );

  it('retains older activity at the four-decimal rendering threshold', () => {
    const result = getSessionCostBreakdown([], 50, 0);

    expect(result.totalCostUsd).toBe(0.00005);
    expect(result.olderActivityCostUsd).toBe(0.00005);
  });

  it('retains an exact 50-microdollar older-activity residual with nonzero live cost', () => {
    const result = getSessionCostBreakdown([createAssistantMessage(0.1)], 100_050, 0.1);

    expect(result.totalCostUsd).toBe(0.10005);
    expect(result.olderActivityCostUsd).toBe(0.00005);
  });

  it('suppresses a 49-microdollar older-activity residual with nonzero live cost', () => {
    const result = getSessionCostBreakdown([createAssistantMessage(0.1)], 100_049, 0.1);

    expect(result.totalCostUsd).toBe(0.100049);
    expect(result.olderActivityCostUsd).toBe(0);
  });

  it('retains older activity above the four-decimal rendering threshold', () => {
    const result = getSessionCostBreakdown([createAssistantMessage(0.05)], 50_200, 0.05);

    expect(result.totalCostUsd).toBe(0.0502);
    expect(result.olderActivityCostUsd).toBeCloseTo(0.0002, 12);
  });

  it('excludes user messages even when their parts contain step-finish costs', () => {
    const userMessage: StoredMessage = {
      info: {
        id: 'user-1',
        sessionID: 'session-1',
        role: 'user',
        time: { created: 1 },
        agent: 'test-agent',
        model: { providerID: 'test-provider', modelID: 'test-model' },
      },
      parts: [createStepFinishPart(0.9)],
    };
    const result = getSessionCostBreakdown(
      [userMessage, createAssistantMessage(0.05, [createStepFinishPart(0.05)])],
      null,
      0.05
    );

    expect(result.rootCostUsd).toBe(0.05);
    expect(result.subagentCostUsd).toBe(0);
  });
});
