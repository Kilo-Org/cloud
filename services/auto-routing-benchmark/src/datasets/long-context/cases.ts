import type { ClassifierSubtaskType, ClassifierTaskType } from '@kilocode/auto-routing-contracts';
import type { DeciderCase } from '../decider-cases';
import { LONG_CONTEXT_GENERATORS, type LongContextGeneratorId } from './generators';

const ROUTES = [
  {
    taskType: 'implementation',
    subtaskType: 'feature_development',
    request:
      'Implement the integration feature by deriving its acceptance payload from the existing workspace, not from the obsolete draft.',
  },
  {
    taskType: 'implementation',
    subtaskType: 'code_generation',
    request:
      'Generate a machine-readable integration fixture from the workspace evidence. Resolve every dependency rather than copying a local default.',
  },
  {
    taskType: 'implementation',
    subtaskType: 'test_creation',
    request:
      'Create the golden assertion fixture for a cross-module regression test. Include the resolved values needed to distinguish the contract from the stale implementation.',
  },
  {
    taskType: 'debugging',
    subtaskType: 'bug_fixing',
    request:
      'Fix the integration mismatch by first computing the exact diagnostic and corrected-behavior fixture from the complete workspace.',
  },
  {
    taskType: 'debugging',
    subtaskType: 'test_repair',
    request:
      'Repair a regression test that used an obsolete local default. Derive its replacement expected-value fixture from the selected configuration and current contract.',
  },
  {
    taskType: 'debugging',
    subtaskType: 'root_cause_analysis',
    request:
      'Investigate the release mismatch. Reconstruct the selected dependency path and the expected behavior, excluding irrelevant successful side tasks.',
  },
  {
    taskType: 'refactoring',
    subtaskType: 'code_cleanup',
    request:
      'For cleanup of the integration module, derive the compatibility fixture that must remain unchanged. Distinguish current behavior from the documented correction so cleanup cannot silently absorb a bug fix.',
  },
  {
    taskType: 'refactoring',
    subtaskType: 'architecture_improvement',
    request:
      'Before extracting the integration boundary, generate its cross-module characterization fixture. Resolve policy, caller selection and downstream transformations across the existing architecture.',
  },
  {
    taskType: 'refactoring',
    subtaskType: 'migration',
    request:
      'Prepare the compatibility fixture for migration to the current integration contract. Older versions and superseded instructions are not the migration target.',
  },
  {
    taskType: 'investigation',
    subtaskType: 'repo_exploration',
    request:
      'Explore the workspace to locate the active integration path and reconstruct its complete observable fixture; do not assume nearby defaults are active.',
  },
  {
    taskType: 'investigation',
    subtaskType: 'codebase_understanding',
    request:
      'Explain the integration behavior through a machine-readable evidence summary, resolving the scattered caller, policy and output dependencies.',
  },
  {
    taskType: 'investigation',
    subtaskType: 'external_research',
    request:
      'Compare the retrieved vendor contract with the local integration and release instructions. Use the current vendor version rather than its archived documentation to produce the conformance fixture.',
  },
] satisfies readonly {
  taskType: ClassifierTaskType;
  subtaskType: ClassifierSubtaskType;
  request: string;
}[];

const EFFICIENT_VARIANTS = [
  { generator: 'repo-v1', targetTokens: 32000 },
  { generator: 'transcript-v1', targetTokens: 96000 },
  { generator: 'logs-v1', targetTokens: 160000 },
] satisfies readonly { generator: LongContextGeneratorId; targetTokens: number }[];

const FRONTIER_GENERATORS: readonly LongContextGeneratorId[] = [
  'repo-frontier-v1',
  'transcript-frontier-v1',
  'logs-frontier-v1',
];

function createCase(
  route: (typeof ROUTES)[number],
  generator: LongContextGeneratorId,
  seed: number,
  targetTokens: number,
  tier: 'efficient' | 'frontier',
  variant: number
): DeciderCase {
  const scenario = LONG_CONTEXT_GENERATORS[generator].scenario(seed);
  return {
    id: `long-${tier}-${route.taskType}-${route.subtaskType}-${variant + 1}`,
    taskType: route.taskType,
    subtaskType: route.subtaskType,
    tier,
    systemPrompt:
      'You are a precise coding assistant. Read the complete workspace evidence and answer only with the requested JSON object, without markdown or explanations.',
    userPrompt: `${route.request}\n\n${scenario.question}`,
    longContext: { generator, seed, targetTokens },
    check: { kind: 'json_equal', value: scenario.answer },
  };
}

export const LONG_CONTEXT_CASES: readonly DeciderCase[] = ROUTES.flatMap((route, routeIndex) =>
  EFFICIENT_VARIANTS.map((variant, variantIndex) =>
    createCase(
      route,
      route.subtaskType === 'external_research' && variant.generator === 'repo-v1'
        ? 'logs-v1'
        : variant.generator,
      41001 + routeIndex * 101 + variantIndex * 17,
      variant.targetTokens,
      'efficient',
      variantIndex
    )
  )
);

export const FRONTIER_LONG_CONTEXT_CASES: readonly DeciderCase[] = ROUTES.flatMap(
  (route, routeIndex) =>
    [0, 1].map(variantIndex => {
      const generator =
        route.subtaskType === 'external_research'
          ? variantIndex === 0
            ? 'transcript-frontier-v1'
            : 'logs-frontier-v1'
          : FRONTIER_GENERATORS[(routeIndex + variantIndex) % FRONTIER_GENERATORS.length];
      if (generator === undefined) throw new Error('Missing frontier long-context generator');
      return createCase(
        route,
        generator,
        81001 + routeIndex * 101 + variantIndex * 17,
        160000,
        'frontier',
        variantIndex
      );
    })
);
