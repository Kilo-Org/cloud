import { describe, expect, it } from 'vitest';
import {
  classifierOutputSchema,
  parseClassifierOutput,
  type ClassifierOutputParseError,
  type ClassifierOutput,
} from './index';

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
});

describe('classifier output parser', () => {
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

  it('accepts common wrappers and ignores extra keys', () => {
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

  it('normalizes enum labels to taxonomy ids', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          taskType: 'Debugging',
          subtaskType: 'Root Cause Analysis',
          contextComplexity: 'Large',
          reasoningComplexity: 'High',
          riskLevel: 'Medium',
          executionMode: 'Multi Step Project',
          requiresTools: 'true',
          confidence: '91%',
        })
      )
    ).toEqual(validOutput);
  });

  it('accepts snake_case output keys', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          task_type: 'debugging',
          subtask_type: 'root_cause_analysis',
          context_complexity: 'large',
          reasoning_complexity: 'high',
          risk_level: 'medium',
          execution_mode: 'multi_step_project',
          requires_tools: true,
          confidence: 0.91,
        })
      )
    ).toEqual(validOutput);
  });

  it('infers task type from a valid subtype', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          ...validOutput,
          taskType: 'not a task',
          subtaskType: 'feature_development',
        })
      )
    ).toEqual({
      ...validOutput,
      taskType: 'implementation',
      subtaskType: 'feature_development',
    });
  });

  it('repairs mismatched subtype relationships with the task default', () => {
    expect(
      parseClassifierOutput(
        JSON.stringify({
          ...validOutput,
          taskType: 'implementation',
          subtaskType: 'root_cause_analysis',
        })
      )
    ).toEqual({
      ...validOutput,
      taskType: 'implementation',
      subtaskType: 'feature_development',
    });
  });

  it('normalizes confidence labels returned by the model', () => {
    expect(parseClassifierOutput(JSON.stringify({ ...validOutput, confidence: 'high' }))).toEqual({
      ...validOutput,
      confidence: 0.85,
    });
  });

  it('reports invalid JSON without raw model output', () => {
    expect(() => parseClassifierOutput('The request is debugging.')).toThrowError(
      expect.objectContaining({
        failureStage: 'invalid_json',
        schemaIssueSummary: [],
      }) as ClassifierOutputParseError
    );
  });

  it('reports schema issues without raw model output', () => {
    expect(() => parseClassifierOutput(JSON.stringify({ confidence: 0.9 }))).toThrowError(
      expect.objectContaining({
        failureStage: 'invalid_schema',
        schemaIssueSummary: expect.arrayContaining(['taskType:invalid_value']),
        topLevelKeys: ['confidence'],
      }) as ClassifierOutputParseError
    );
  });
});
