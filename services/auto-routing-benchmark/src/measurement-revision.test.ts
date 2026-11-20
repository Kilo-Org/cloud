import { describe, expect, it } from 'vitest';
import { CONTINUATION_CASES } from './datasets/continuation-cases';
import { DECIDER_CASES, FRONTIER_CASES } from './datasets/decider-cases';
import { lacksRequiredToolCalls, runDeciderCheck } from './grading';
import {
  CLIENT_EVAL_REVISION,
  deciderCasesForRouter,
  gradingRevision,
  MEASUREMENT_REVISION,
  minimumCaseRevisions,
} from './measurement-revision';
import { argvAffectedCases, PROMPT_TRANSPORT_REVISION } from './prompt-transport';

describe('measurement revisions', () => {
  const current = deciderCasesForRouter('efficient', MEASUREMENT_REVISION);
  const byId = new Map(current.map(benchCase => [benchCase.id, benchCase]));

  it('runs the revision-2 cases unchanged for runs started before revision 3', () => {
    expect(deciderCasesForRouter('efficient', PROMPT_TRANSPORT_REVISION)).toBe(DECIDER_CASES);
    expect(deciderCasesForRouter('efficient', CLIENT_EVAL_REVISION)).toBe(DECIDER_CASES);
    expect(deciderCasesForRouter('frontier', MEASUREMENT_REVISION)).toBe(FRONTIER_CASES);
  });

  it('requires a tool call on every efficient agentic case and changes nothing else', () => {
    for (const benchCase of DECIDER_CASES) {
      const revised = byId.get(benchCase.id);
      if (benchCase.taskType === 'agentic_execution') {
        expect(revised?.requiredToolCalls).toBe(1);
      } else {
        expect(revised).toBe(benchCase);
      }
    }
    expect(current.map(benchCase => benchCase.id)).toEqual([
      ...DECIDER_CASES.map(benchCase => benchCase.id),
      ...CONTINUATION_CASES.map(benchCase => benchCase.id),
    ]);
  });

  it('accepts only the true pwd answer: the case runs in a temp directory, never /app', () => {
    const pwdCase = byId.get('supp-agent-term-pwd-base');
    if (!pwdCase || pwdCase.check.kind === 'judged') throw new Error('missing mechanical pwd case');
    expect(runDeciderCheck(pwdCase.check, 'other')).toBe(true);
    expect(runDeciderCheck(pwdCase.check, 'app')).toBe(false);
  });

  it('scores an answer without the required tool calls as missing evidence', () => {
    expect(lacksRequiredToolCalls(1, 0)).toBe(true);
    expect(lacksRequiredToolCalls(1, null)).toBe(true);
    expect(lacksRequiredToolCalls(1, 1)).toBe(false);
    expect(lacksRequiredToolCalls(undefined, 0)).toBe(false);
  });

  it('re-measures every tool-evidence case below revision 3 and argv cases below 2', () => {
    const minimums = minimumCaseRevisions('efficient', MEASUREMENT_REVISION);
    for (const benchCase of current) {
      if (benchCase.taskType === 'agentic_execution') {
        expect(minimums[benchCase.id]).toBe(MEASUREMENT_REVISION);
      }
    }
    for (const benchCase of argvAffectedCases('efficient')) {
      if (benchCase.taskType !== 'agentic_execution') {
        expect(minimums[benchCase.id]).toBe(PROMPT_TRANSPORT_REVISION);
      }
    }
    expect(Object.keys(minimums)).toHaveLength(
      new Set([
        ...argvAffectedCases('efficient').map(benchCase => benchCase.id),
        ...current
          .filter(benchCase => benchCase.taskType === 'agentic_execution')
          .map(benchCase => benchCase.id),
      ]).size
    );
    expect(minimumCaseRevisions('frontier', MEASUREMENT_REVISION)).toEqual(
      minimumCaseRevisions('frontier', PROMPT_TRANSPORT_REVISION)
    );
  });

  it('separates gradings only where revision 3 changed them', () => {
    expect(gradingRevision('efficient', 2)).not.toBe(gradingRevision('efficient', 3));
    expect(gradingRevision('frontier', 2)).toBe(gradingRevision('frontier', 3));
  });
});
