import classifierTaxonomy from './classifier-taxonomy.json';
import type { NormalizedClassifierInput } from './classifier-input';

export const DEFAULT_CLASSIFIER_MODEL = 'google/gemini-2.5-flash-lite';
export const CLASSIFIER_MAX_TOKENS = 160;

export type ClassifierMessage = {
  role: 'system' | 'user';
  content: string;
};

const SYSTEM_PROMPT_PREFIX_MAX_LENGTH = 200;
const USER_PROMPT_PREFIX_MAX_LENGTH = 800;

type ClassifierPromptSummary = {
  apiKind: NormalizedClassifierInput['apiKind'];
  systemPromptPrefix: string | null;
  initialUserPromptPrefix: string | null;
  latestUserPromptPrefix: string | null;
  messageCount: number | null;
  hasTools: boolean;
};

const classifierAxisKeys = [
  'contextComplexity',
  'reasoningComplexity',
  'riskLevel',
  'executionMode',
] as const;

const taskTypes = classifierTaxonomy.taskTypes.map(taskType => ({
  id: taskType.id,
  description: taskType.description,
  subtypes: taskType.subtypes.map(subtype => ({
    id: subtype.id,
    description: subtype.description,
  })),
}));

function axisIds(axisKey: (typeof classifierAxisKeys)[number]) {
  return classifierTaxonomy.axes[axisKey].values.map(value => value.id);
}

function axisGuide(axisKey: (typeof classifierAxisKeys)[number]) {
  return classifierTaxonomy.axes[axisKey].values.map(value => ({
    id: value.id,
    description: value.description,
  }));
}

const axisOutputValues = {
  contextComplexity: axisIds('contextComplexity'),
  reasoningComplexity: axisIds('reasoningComplexity'),
  riskLevel: axisIds('riskLevel'),
  executionMode: axisIds('executionMode'),
};

const allowedOutputValues = {
  taskType: taskTypes.map(taskType => taskType.id),
  subtaskTypeByTaskType: Object.fromEntries(
    taskTypes.map(taskType => [taskType.id, taskType.subtypes.map(subtype => subtype.id)])
  ),
  ...axisOutputValues,
};

const compactTaxonomy = {
  decisionRules: classifierTaxonomy.decisionRules,
  taskTypes,
  axes: Object.fromEntries(classifierAxisKeys.map(axisKey => [axisKey, axisGuide(axisKey)])),
};

function buildClassifierPromptSummary(input: NormalizedClassifierInput): ClassifierPromptSummary {
  return {
    apiKind: input.apiKind,
    systemPromptPrefix: input.systemPromptPrefix?.slice(0, SYSTEM_PROMPT_PREFIX_MAX_LENGTH) ?? null,
    initialUserPromptPrefix:
      input.userPromptPrefix?.slice(0, USER_PROMPT_PREFIX_MAX_LENGTH) ?? null,
    latestUserPromptPrefix:
      input.latestUserPromptPrefix && input.latestUserPromptPrefix !== input.userPromptPrefix
        ? input.latestUserPromptPrefix.slice(0, USER_PROMPT_PREFIX_MAX_LENGTH)
        : null,
    messageCount: input.messageCount,
    hasTools: input.hasTools,
  };
}

export function buildClassifierMessages(input: NormalizedClassifierInput): ClassifierMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You classify mirrored coding-agent requests for future model routing.',
        'Return exactly one minified JSON object. No markdown, code fence, prose, rationale, or extra keys.',
        'Required keys: taskType, subtaskType, contextComplexity, reasoningComplexity, riskLevel, executionMode, requiresTools, confidence.',
        'Use only the exact string IDs listed in allowedOutputValues. subtaskType must be listed under the selected taskType.',
        'Classify the primary user intent from the request summary, not the requested model.',
        'initialUserPromptPrefix is the first user turn; latestUserPromptPrefix can redirect or refine the current request.',
        'If initial and latest user prompts conflict, prefer latestUserPromptPrefix for the current request.',
        `allowedOutputValues: ${JSON.stringify(allowedOutputValues)}`,
        `taxonomyGuide: ${JSON.stringify(compactTaxonomy)}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Request summary:\n${JSON.stringify(buildClassifierPromptSummary(input))}`,
    },
  ];
}
