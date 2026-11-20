import { describe, expect, it } from 'vitest';
import { DECIDER_CASES, FRONTIER_CASES } from './datasets/decider-cases';
import { PROBE_CASES, isProbeCase } from './datasets/probe-cases';
import { gradeProbeOutput, lacksRequiredToolCalls, runDeciderCheck } from './grading';
import {
  CLIENT_EVAL_REVISION,
  deciderCasesForRouter,
  gradingRevision,
  MEASUREMENT_REVISION,
  minimumCaseRevisions,
  PROBE_REVISION,
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

  it('changes only the pwd case and adds the probe cases', () => {
    for (const benchCase of DECIDER_CASES) {
      const revised = byId.get(benchCase.id);
      if (benchCase.id === 'supp-agent-term-pwd-base') {
        expect(revised).not.toBe(benchCase);
        expect(revised && !isProbeCase(revised) ? revised.requiredToolCalls : undefined).toBe(1);
      } else {
        expect(revised).toBe(benchCase);
      }
    }
    expect(current).toHaveLength(DECIDER_CASES.length + PROBE_CASES.length);
  });

  it('adds probe cases that carry a cut, a transcript and no CLI prompt', () => {
    for (const probeCase of PROBE_CASES) {
      const revised = byId.get(probeCase.id);
      if (!revised || !isProbeCase(revised)) throw new Error(`${probeCase.id} is not a probe`);
      expect('userPrompt' in revised).toBe(false);
      expect(revised.probe.cutAfterStep).toBe(probeCase.probe.cutAfterStep);
      expect(revised.probe.transcript.session.steps.length).toBeGreaterThanOrEqual(
        revised.probe.cutAfterStep
      );
      expect(revised.taskType).toBe('agentic_execution');
    }
  });

  it('grades a probe on the tool call or the correct answer, never on narration', () => {
    const probeCase = PROBE_CASES[0]!;
    const answer = JSON.stringify(probeCase.check.value);
    expect(gradeProbeOutput(probeCase.check, { text: answer, toolCalls: 0 })).toBe(1);
    expect(
      gradeProbeOutput(probeCase.check, { text: 'I will inspect the data next.', toolCalls: 0 })
    ).toBe(0);
    expect(gradeProbeOutput(probeCase.check, { text: '', toolCalls: 0 })).toBe(0);
    expect(gradeProbeOutput(probeCase.check, { text: '', toolCalls: 2 })).toBe(1);
  });

  it('accepts only the true pwd answer: the case runs in a temp directory, never /app', () => {
    const pwdCase = byId.get('supp-agent-term-pwd-base');
    if (!pwdCase || isProbeCase(pwdCase) || pwdCase.check.kind === 'judged') {
      throw new Error('missing mechanical pwd case');
    }
    expect(runDeciderCheck(pwdCase.check, 'other')).toBe(true);
    expect(runDeciderCheck(pwdCase.check, 'app')).toBe(false);
  });

  it('scores an answer without the required tool calls as missing evidence', () => {
    expect(lacksRequiredToolCalls(1, 0)).toBe(true);
    expect(lacksRequiredToolCalls(1, null)).toBe(true);
    expect(lacksRequiredToolCalls(1, 1)).toBe(false);
    expect(lacksRequiredToolCalls(undefined, 0)).toBe(false);
  });

  it('re-measures only the probe cases and pwd-base below revision 3', () => {
    const minimums = minimumCaseRevisions('efficient', MEASUREMENT_REVISION);
    const expected = new Set([
      ...argvAffectedCases('efficient').map(benchCase => benchCase.id),
      'supp-agent-term-pwd-base',
      ...PROBE_CASES.map(probeCase => probeCase.id),
    ]);
    expect(Object.keys(minimums).toSorted()).toEqual([...expected].toSorted());
    for (const probeCase of PROBE_CASES) {
      expect(minimums[probeCase.id]).toBe(PROBE_REVISION);
    }
    expect(minimums['supp-agent-term-pwd-base']).toBe(PROBE_REVISION);
    for (const benchCase of argvAffectedCases('efficient')) {
      if (benchCase.taskType !== 'agentic_execution') {
        expect(minimums[benchCase.id]).toBe(PROMPT_TRANSPORT_REVISION);
      }
    }
    expect(minimumCaseRevisions('frontier', MEASUREMENT_REVISION)).toEqual(
      minimumCaseRevisions('frontier', PROMPT_TRANSPORT_REVISION)
    );
  });

  it('separates gradings only where revision 3 changed them', () => {
    expect(gradingRevision('efficient', 2)).not.toBe(gradingRevision('efficient', 3));
    expect(gradingRevision('frontier', 2)).toBe(gradingRevision('frontier', 3));
  });
});
