import type { ClassifierSubtaskType, ClassifierTaskType } from '@kilocode/auto-routing-contracts';
import type { ProbeAnswerCheck } from '../grading';
import { PROBE_TRANSCRIPTS, type ProbeTranscript } from './probe-transcripts';

/**
 * Where one probe request's history ends: after this many completed steps of the
 * transcript, so the request ends on a tool result with no further user message.
 * Dropping or adding a cut is a data change; nothing else keys off the step count.
 */
export type ProbeCut = { transcriptId: string; cutAfterStep: number };

export type ProbeCase = {
  id: string;
  taskType: ClassifierTaskType;
  subtaskType: ClassifierSubtaskType;
  check: ProbeAnswerCheck;
  probe: ProbeCut & { transcript: ProbeTranscript };
};

export const PROBE_CUTS: readonly ProbeCut[] = [
  { transcriptId: 'cont-agent-tool-invoice-rollup', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-tool-invoice-rollup', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-tool-invoice-rollup', cutAfterStep: 3 },
  { transcriptId: 'cont-agent-tool-access-latency', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-tool-access-latency', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-tool-i18n-sync', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-tool-i18n-sync', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-tool-i18n-sync', cutAfterStep: 3 },
  { transcriptId: 'cont-agent-term-env-rollout', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-term-env-rollout', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-term-log-split', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-term-log-split', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-term-migration-renumber', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-term-migration-renumber', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-term-migration-renumber', cutAfterStep: 3 },
  { transcriptId: 'cont-agent-multi-pricing-fix', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-multi-pricing-fix', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-multi-user-migration', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-multi-user-migration', cutAfterStep: 2 },
  { transcriptId: 'cont-agent-multi-etl-dedupe', cutAfterStep: 1 },
  { transcriptId: 'cont-agent-multi-etl-dedupe', cutAfterStep: 2 },
];

export function probeCaseId(transcriptId: string, cutAfterStep: number): string {
  return `probe-${transcriptId}-step-${cutAfterStep}`;
}

/** The transcript a cut names, or a throw when the cut is not one of its step ends. */
export function probeTranscriptFor(cut: ProbeCut): ProbeTranscript {
  const transcript = PROBE_TRANSCRIPTS.find(entry => entry.id === cut.transcriptId);
  if (!transcript) throw new Error(`probe cut names an unknown transcript: ${cut.transcriptId}`);
  if (cut.cutAfterStep < 1 || cut.cutAfterStep > transcript.session.steps.length) {
    throw new Error(
      `${cut.transcriptId} has ${transcript.session.steps.length} steps, no cut after ${cut.cutAfterStep}`
    );
  }
  return transcript;
}

export const PROBE_CASES: readonly ProbeCase[] = PROBE_CUTS.map(cut => {
  const transcript = probeTranscriptFor(cut);
  return {
    id: probeCaseId(cut.transcriptId, cut.cutAfterStep),
    taskType: transcript.taskType,
    subtaskType: transcript.subtaskType,
    check: transcript.check,
    probe: { ...cut, transcript },
  };
});

// Typed on `object` so it narrows a `DeciderCase | ProbeCase` union from either side: the
// true branch leaves a ProbeCase, the false branch a DeciderCase.
export function isProbeCase(benchCase: object): benchCase is ProbeCase {
  return 'probe' in benchCase && benchCase.probe !== undefined;
}
