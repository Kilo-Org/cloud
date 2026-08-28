import { describe, expect, it } from 'vitest';
import { TriggerConfigInput, TriggerConfigUpdateInput } from './api';

describe('trigger variant validation', () => {
  const createInput = {
    githubRepo: 'owner/repo',
    mode: 'code',
    model: 'openai/gpt-4.1',
    promptTemplate: 'Process {{body}}',
    profileId: '5d08c60b-7755-4dd3-b3fc-7ae96bf50e22',
  };

  it('accepts an omitted or alphabetic variant up to 50 characters on create', () => {
    expect(TriggerConfigInput.safeParse(createInput).success).toBe(true);
    expect(TriggerConfigInput.safeParse({ ...createInput, variant: 'a'.repeat(50) }).success).toBe(
      true
    );
  });

  it('rejects non-alphabetic and oversized create variants', () => {
    expect(TriggerConfigInput.safeParse({ ...createInput, variant: 'high-effort' }).success).toBe(
      false
    );
    expect(TriggerConfigInput.safeParse({ ...createInput, variant: 'a'.repeat(51) }).success).toBe(
      false
    );
  });

  it('accepts null to clear a variant on update and rejects invalid values', () => {
    expect(TriggerConfigUpdateInput.safeParse({ variant: null }).success).toBe(true);
    expect(TriggerConfigUpdateInput.safeParse({ variant: 'medium' }).success).toBe(true);
    expect(TriggerConfigUpdateInput.safeParse({ variant: 'medium-1' }).success).toBe(false);
  });
});
