import { describe, expect, it } from 'vitest';
import {
  classifierOutputSchema,
  parseClassifierOutput,
  type ClassifierOutput,
} from './classification';

const validOutput = {
  taskType: 'debugging',
  subtaskType: 'root_cause_analysis',
  contextComplexity: 'large',
  reasoningComplexity: 'high',
  riskLevel: 'medium',
  executionMode: 'multi_step_project',
  requiresTools: true,
  confidence: 0.91,
} satisfies ClassifierOutput;

describe('classifier output validation', () => {
  it('accepts the strict classifier JSON contract', () => {
    expect(classifierOutputSchema.parse(validOutput)).toEqual(validOutput);
  });

  it('rejects a subtype that does not belong to the selected task type', () => {
    expect(() =>
      classifierOutputSchema.parse({
        ...validOutput,
        taskType: 'implementation',
        subtaskType: 'root_cause_analysis',
      })
    ).toThrow();
  });

  it('parses JSON returned by the model', () => {
    expect(parseClassifierOutput(JSON.stringify(validOutput))).toEqual(validOutput);
  });

  it('rejects non-JSON model output', () => {
    expect(() => parseClassifierOutput('The request is debugging.')).toThrow(
      'Classifier model returned invalid JSON'
    );
  });
});
