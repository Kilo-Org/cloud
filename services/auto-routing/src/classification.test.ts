import { describe, expect, it } from 'vitest';
import {
  classifierOutputSchema,
  parseClassifierOutput,
  type ClassifierOutputParseError,
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

  it('parses JSON from fenced model output', () => {
    expect(parseClassifierOutput(`\`\`\`json\n${JSON.stringify(validOutput)}\n\`\`\``)).toEqual(
      validOutput
    );
  });

  it('parses JSON from model output with surrounding prose', () => {
    expect(
      parseClassifierOutput(`Here is the classification:\n${JSON.stringify(validOutput)}`)
    ).toEqual(validOutput);
  });

  it('accepts harmless wrappers and extra keys from model output', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          classification: {
            ...validOutput,
            rationale: 'debugging request',
          },
        })
      )
    ).toEqual(validOutput);
  });

  it('normalizes confidence strings returned by the model', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          ...validOutput,
          confidence: '91%',
        })
      )
    ).toEqual(validOutput);
  });

  it('normalizes confidence labels returned by the model', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          ...validOutput,
          confidence: 'high',
        })
      )
    ).toEqual({
      ...validOutput,
      confidence: 0.85,
    });
  });

  it('extracts confidence numbers from decorated strings returned by the model', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          ...validOutput,
          confidence: 'about 91 percent',
        })
      )
    ).toEqual(validOutput);
  });

  it('normalizes confidence wrapper objects returned by the model', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          ...validOutput,
          confidence: { score: '91%' },
        })
      )
    ).toEqual(validOutput);
  });

  it('reports field types when classifier output still fails validation', () => {
    expect(() =>
      parseClassifierOutput(
        JSON.stringify({
          ...validOutput,
          confidence: null,
        })
      )
    ).toThrowError(
      expect.objectContaining({
        fieldTypeSummary: expect.arrayContaining(['confidence:null']),
      }) as ClassifierOutputParseError
    );
  });

  it('rejects non-JSON model output', () => {
    expect(() => parseClassifierOutput('The request is debugging.')).toThrow(
      'Classifier model returned invalid JSON'
    );
  });
});
