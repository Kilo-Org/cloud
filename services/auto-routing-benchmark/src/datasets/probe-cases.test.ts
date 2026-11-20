import { describe, expect, it } from 'vitest';
import { PROBE_CASES, probeCaseId, probeTranscriptFor } from './probe-cases';
import { PROBE_TRANSCRIPTS } from './probe-transcripts';

describe('PROBE_CASES', () => {
  it('cuts every transcript at the end of each step it ran, 21 cases in all', () => {
    expect(PROBE_CASES).toHaveLength(21);
    const expected = PROBE_TRANSCRIPTS.flatMap(transcript =>
      transcript.session.steps.map((_, index) => probeCaseId(transcript.id, index + 1))
    );
    expect(PROBE_CASES.map(entry => entry.id)).toEqual(expected);
  });

  it('keeps ids unique and disjoint from the measured decider cases', () => {
    const ids = PROBE_CASES.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids)
      expect(id).toMatch(/^probe-cont-agent-(tool|term|multi)-[a-z0-9-]+-step-[1-3]$/);
  });

  it('ends each cut on a tool result with the transcript route and full history before it', () => {
    for (const probeCase of PROBE_CASES) {
      const { transcript, cutAfterStep } = probeCase.probe;
      expect(probeCase.taskType).toBe(transcript.taskType);
      expect(probeCase.subtaskType).toBe(transcript.subtaskType);
      expect(probeCase.check).toBe(transcript.check);
      expect(cutAfterStep).toBeGreaterThanOrEqual(1);
      expect(cutAfterStep).toBeLessThanOrEqual(transcript.session.steps.length);
      const steps = transcript.session.steps.slice(0, cutAfterStep);
      expect(steps.at(-1)?.calls.length).toBeGreaterThan(0);
    }
  });

  it('rejects a cut past the last step or on an unknown transcript', () => {
    const transcript = PROBE_TRANSCRIPTS[0]!;
    expect(probeTranscriptFor({ transcriptId: transcript.id, cutAfterStep: 1 })).toBe(transcript);
    expect(() =>
      probeTranscriptFor({
        transcriptId: transcript.id,
        cutAfterStep: transcript.session.steps.length + 1,
      })
    ).toThrow(/no cut after/);
    expect(() =>
      probeTranscriptFor({ transcriptId: 'cont-agent-missing', cutAfterStep: 1 })
    ).toThrow(/unknown transcript/);
  });
});
