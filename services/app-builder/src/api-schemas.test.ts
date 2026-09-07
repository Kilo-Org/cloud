import { describe, expect, it } from 'vitest';
import { MigrateToGithubRequestSchema } from './api-schemas';

describe('MigrateToGithubRequestSchema', () => {
  const request = {
    githubRepo: 'kilocode/example',
    userId: 'user_2abc123',
  };

  it('accepts non-empty text user IDs', () => {
    expect(MigrateToGithubRequestSchema.parse(request)).toEqual(request);
  });

  it('rejects empty user IDs', () => {
    expect(() => MigrateToGithubRequestSchema.parse({ ...request, userId: '' })).toThrow();
  });

  it('keeps organization IDs UUID-only', () => {
    expect(() =>
      MigrateToGithubRequestSchema.parse({ ...request, orgId: 'org_2abc123' })
    ).toThrow();
    expect(
      MigrateToGithubRequestSchema.parse({
        ...request,
        orgId: '123e4567-e89b-42d3-a456-426614174000',
      })
    ).toEqual({
      ...request,
      orgId: '123e4567-e89b-42d3-a456-426614174000',
    });
  });
});
