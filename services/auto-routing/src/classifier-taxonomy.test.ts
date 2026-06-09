import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

const TaxonomyValueSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  useWhen: z.array(z.string().min(1)).min(1),
  avoidWhen: z.array(z.string().min(1)),
  examples: z.array(z.string().min(1)).min(1),
});

const TaskTypeSchema = TaxonomyValueSchema.extend({
  subtypes: z.array(TaxonomyValueSchema).min(1),
});

const AxisSchema = z.object({
  kind: z.enum(['single_select', 'derived_select']),
  description: z.string().min(1),
  values: z.array(TaxonomyValueSchema).min(1),
});

const TaxonomySchema = z.object({
  version: z.literal(1),
  outputContract: z.object({
    taskType: z.string(),
    subtaskType: z.string(),
    contextComplexity: z.string(),
    reasoningComplexity: z.string(),
    riskLevel: z.string(),
    executionMode: z.string(),
    requiresTools: z.string(),
    confidence: z.string(),
  }),
  decisionRules: z.array(z.string().min(1)).min(1),
  taskTypes: z.array(TaskTypeSchema).min(1),
  axes: z.object({
    contextComplexity: AxisSchema,
    reasoningComplexity: AxisSchema,
    riskLevel: AxisSchema,
    executionMode: AxisSchema,
    requiresTools: AxisSchema,
  }),
});

async function readTaxonomy() {
  const file = await readFile(join(__dirname, 'classifier-taxonomy.json'), 'utf8');
  return TaxonomySchema.parse(JSON.parse(file));
}

describe('classifier taxonomy', () => {
  it('defines the classifier output contract and required routing labels', async () => {
    const taxonomy = await readTaxonomy();

    expect(taxonomy.taskTypes.map(value => value.id)).toEqual([
      'implementation',
      'debugging',
      'refactoring',
      'planning_design',
      'investigation',
      'agentic_execution',
    ]);
    expect(taxonomy.axes.contextComplexity.values.map(value => value.id)).toEqual([
      'small',
      'medium',
      'large',
    ]);
    expect(taxonomy.axes.reasoningComplexity.values.map(value => value.id)).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(taxonomy.axes.riskLevel.values.map(value => value.id)).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(taxonomy.axes.executionMode.values.map(value => value.id)).toEqual([
      'answer_only',
      'code_change',
      'command_execution',
      'multi_step_project',
    ]);
  });
});
