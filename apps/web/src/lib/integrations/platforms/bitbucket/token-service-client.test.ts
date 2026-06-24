import { describe, expect, it } from '@jest/globals';
import { BitbucketRepositoryListResultSchema } from './token-service-client';

describe('BitbucketRepositoryListResultSchema', () => {
  it.each(['insufficient_permissions', 'invalid_request'] as const)(
    'accepts the static token-service %s result',
    status => {
      expect(BitbucketRepositoryListResultSchema.parse({ status })).toEqual({ status });
    }
  );
});
