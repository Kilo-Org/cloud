import classifierTaxonomy from './classifier-taxonomy.json';
import type { NormalizedClassifierInput } from './classifier-input';

export const DEFAULT_CLASSIFIER_MODEL = 'google/gemini-2.5-flash-lite';
export const CLASSIFIER_MAX_TOKENS = 160;

export type ClassifierMessage = {
  role: 'system' | 'user';
  content: string;
};

const taskTypes = classifierTaxonomy.taskTypes.map(taskType => ({
  id: taskType.id,
  description: taskType.description,
  subtypes: taskType.subtypes.map(subtype => ({
    id: subtype.id,
    description: subtype.description,
  })),
}));

const allowedOutputValues = {
  taskType: taskTypes.map(taskType => taskType.id),
  subtaskTypeByTaskType: Object.fromEntries(
    taskTypes.map(taskType => [taskType.id, taskType.subtypes.map(subtype => subtype.id)])
  ),
  contextComplexity: classifierTaxonomy.axes.contextComplexity.values.map(value => value.id),
  reasoningComplexity: classifierTaxonomy.axes.reasoningComplexity.values.map(value => value.id),
  riskLevel: classifierTaxonomy.axes.riskLevel.values.map(value => value.id),
  executionMode: classifierTaxonomy.axes.executionMode.values.map(value => value.id),
};

const compactTaxonomy = {
  decisionRules: classifierTaxonomy.decisionRules,
  taskTypes,
  axes: {
    contextComplexity: classifierTaxonomy.axes.contextComplexity.values.map(value => ({
      id: value.id,
      description: value.description,
    })),
    reasoningComplexity: classifierTaxonomy.axes.reasoningComplexity.values.map(value => ({
      id: value.id,
      description: value.description,
    })),
    riskLevel: classifierTaxonomy.axes.riskLevel.values.map(value => ({
      id: value.id,
      description: value.description,
    })),
    executionMode: classifierTaxonomy.axes.executionMode.values.map(value => ({
      id: value.id,
      description: value.description,
    })),
  },
};

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
        `allowedOutputValues: ${JSON.stringify(allowedOutputValues)}`,
        `taxonomyGuide: ${JSON.stringify(compactTaxonomy)}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Request summary:\n${JSON.stringify(input)}`,
    },
  ];
}
