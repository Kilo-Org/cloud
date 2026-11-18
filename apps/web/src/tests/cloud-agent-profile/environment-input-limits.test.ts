/**
 * The update mutation's input schemas are the transport bound on how many
 * variables and secret changes one request may carry. They are exercised here
 * because the bound has to hold before any handler runs.
 */
import { ENVIRONMENT_LIMITS } from '@kilocode/cloud-agent-profile';
import {
  environmentPlainVarsSchema,
  environmentSecretChangesSchema,
} from '@/routers/cloud-environments-router';

function plainVars(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`VAR_${index}`, 'value']));
}

function secretChanges(count: number): Array<{ key: string; value: string }> {
  return Array.from({ length: count }, (_, index) => ({
    key: `SECRET_${index}`,
    value: 'value',
  }));
}

describe('environment update input limits', () => {
  test('bounds the plaintext variables at the variable cap', () => {
    expect(
      environmentPlainVarsSchema.safeParse(plainVars(ENVIRONMENT_LIMITS.MAX_VARS)).success
    ).toBe(true);
    expect(
      environmentPlainVarsSchema.safeParse(plainVars(ENVIRONMENT_LIMITS.MAX_VARS + 1)).success
    ).toBe(false);
  });

  test('bounds the secret change list at one whole replacement', () => {
    expect(
      environmentSecretChangesSchema.safeParse(secretChanges(2 * ENVIRONMENT_LIMITS.MAX_VARS))
        .success
    ).toBe(true);
    expect(
      environmentSecretChangesSchema.safeParse(secretChanges(2 * ENVIRONMENT_LIMITS.MAX_VARS + 1))
        .success
    ).toBe(false);
  });
});
