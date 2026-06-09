import classifierTaxonomy from './classifier-taxonomy.json';
import type { NormalizedClassifierInput } from './classifier-input';

export const DEFAULT_CLASSIFIER_MODEL = 'google/gemma-4-31b-it';

export type ClassifierMessage = {
  role: 'system' | 'user';
  content: string;
};

const outputSchemaSummary = {
  taskType: 'taxonomy taskTypes[].id',
  subtaskType: 'taxonomy subtype id under taskType',
  contextComplexity: 'small | medium | large',
  reasoningComplexity: 'low | medium | high',
  riskLevel: 'low | medium | high',
  executionMode: 'answer_only | code_change | command_execution | multi_step_project',
  requiresTools: 'boolean',
  confidence: 'number from 0 to 1',
};

export function buildClassifierMessages(input: NormalizedClassifierInput): ClassifierMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You classify mirrored coding-agent requests for future model routing.',
        `Return only JSON matching this schema: ${JSON.stringify(outputSchemaSummary)}.`,
        'Use taxonomy labels exactly. Classify the primary user intent from the request summary, not the requested model.',
        'Do not answer the request. Do not include rationale or markdown.',
        `Taxonomy: ${JSON.stringify(classifierTaxonomy)}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Request summary:\n${JSON.stringify(input)}`,
    },
  ];
}
