import { ClassifierOutputSchema, type ClassifierOutput } from '@kilocode/auto-routing-contracts';

export const classifierOutputSchema = ClassifierOutputSchema;
export type { ClassifierOutput };

export function parseClassifierOutput(text: string): ClassifierOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Classifier model returned invalid JSON');
  }

  return classifierOutputSchema.parse(parsed);
}
