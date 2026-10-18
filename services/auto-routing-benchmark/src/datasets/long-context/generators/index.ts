import type { LongContextGenerator } from './common';
import { logsFiller, logsScenario } from './logs';
import { repoFiller, repoScenario } from './repo';
import { transcriptFiller, transcriptScenario } from './transcript';

export const LONG_CONTEXT_GENERATORS = {
  'repo-v1': { scenario: repoScenario, filler: repoFiller },
  'transcript-v1': { scenario: transcriptScenario, filler: transcriptFiller },
  'logs-v1': { scenario: logsScenario, filler: logsFiller },
  'repo-frontier-v1': { scenario: (seed: number) => repoScenario(seed, true), filler: repoFiller },
  'transcript-frontier-v1': {
    scenario: (seed: number) => transcriptScenario(seed, true),
    filler: transcriptFiller,
  },
  'logs-frontier-v1': { scenario: (seed: number) => logsScenario(seed, true), filler: logsFiller },
} satisfies Record<string, LongContextGenerator>;

export type LongContextGeneratorId = keyof typeof LONG_CONTEXT_GENERATORS;
