import { describe, test, expect } from 'vitest';
import {
  kiloCommandNameSchema,
  kiloCommandCreateInputSchema,
  kiloCommandUpdateInputSchema,
  BUILTIN_COMMAND_NAMES,
} from './profile-kilo-commands-service';

describe('kiloCommandNameSchema', () => {
  test('accepts valid slug', () => {
    expect(kiloCommandNameSchema.safeParse('commit').success).toBe(true);
  });

  test('accepts slug with dashes', () => {
    expect(kiloCommandNameSchema.safeParse('my-command').success).toBe(true);
  });

  test('accepts slug with digits after first char', () => {
    expect(kiloCommandNameSchema.safeParse('deploy2').success).toBe(true);
  });

  test('rejects uppercase', () => {
    expect(kiloCommandNameSchema.safeParse('Commit').success).toBe(false);
  });

  test('rejects starting with digit', () => {
    expect(kiloCommandNameSchema.safeParse('1command').success).toBe(false);
  });

  test('rejects underscores', () => {
    expect(kiloCommandNameSchema.safeParse('my_command').success).toBe(false);
  });

  test('rejects spaces', () => {
    expect(kiloCommandNameSchema.safeParse('my command').success).toBe(false);
  });

  test('rejects empty string', () => {
    expect(kiloCommandNameSchema.safeParse('').success).toBe(false);
  });

  test('rejects built-in command name', () => {
    const result = kiloCommandNameSchema.safeParse('review');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('built-in');
    }
  });

  test('rejects all built-in command names', () => {
    for (const name of BUILTIN_COMMAND_NAMES) {
      expect(kiloCommandNameSchema.safeParse(name).success).toBe(false);
    }
  });
});

describe('kiloCommandCreateInputSchema', () => {
  test('accepts minimal valid input', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: 'Deploy the application',
    });
    expect(result.success).toBe(true);
  });

  test('accepts full valid input', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      description: 'Deploy to production',
      template: 'Deploy $ARGUMENTS to production',
      agent: 'code',
      model: 'claude-3',
      subtask: true,
    });
    expect(result.success).toBe(true);
  });

  test('rejects missing name', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      template: 'Deploy',
    });
    expect(result.success).toBe(false);
  });

  test('rejects missing template', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
    });
    expect(result.success).toBe(false);
  });

  test('rejects empty template', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: '',
    });
    expect(result.success).toBe(false);
  });

  test('rejects template exceeding max length', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: 'x'.repeat(100_001),
    });
    expect(result.success).toBe(false);
  });

  test('rejects description exceeding max length', () => {
    const result = kiloCommandCreateInputSchema.safeParse({
      name: 'deploy',
      template: 'Deploy',
      description: 'x'.repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe('kiloCommandUpdateInputSchema', () => {
  test('accepts empty update', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts partial update', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({
      template: 'New template',
      subtask: true,
    });
    expect(result.success).toBe(true);
  });

  test('allows nulling optional fields', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({
      description: null,
      agent: null,
      model: null,
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid name in update', () => {
    const result = kiloCommandUpdateInputSchema.safeParse({
      name: 'INVALID',
    });
    expect(result.success).toBe(false);
  });
});
