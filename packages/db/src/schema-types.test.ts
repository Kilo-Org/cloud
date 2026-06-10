import { describe, expect, it } from '@jest/globals';
import { EndpointsSchema } from './schema-types';

describe('EndpointsSchema', () => {
  it('accepts provider endpoints without tags', () => {
    const result = EndpointsSchema.parse({
      data: {
        endpoints: [
          {
            context_length: 128_000,
            pricing: {
              prompt: '0.000001',
              completion: '0.000002',
            },
          },
          {
            tag: 'openai',
            context_length: 128_000,
          },
        ],
      },
    });

    expect(result.data.endpoints[0]?.tag).toBeUndefined();
    expect(result.data.endpoints[1]?.tag).toBe('openai');
  });
});
