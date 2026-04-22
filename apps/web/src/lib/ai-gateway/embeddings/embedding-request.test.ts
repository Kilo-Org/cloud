import { describe, it, expect } from '@jest/globals';
import { buildUpstreamBody } from './embedding-request';

describe('buildUpstreamBody', () => {
  it('should forward all standard fields and strip Mistral-specific and deprecated fields', () => {
    const result = buildUpstreamBody({
      model: 'google/text-embedding-004',
      input: ['text1', 'text2'],
      encoding_format: 'float',
      dimensions: 768,
      safety_identifier: 'hash-abc',
      provider: { order: ['Google'] },
      input_type: 'search_document',
      output_dtype: 'int8',
      output_dimension: 256,
    });

    expect(result).toEqual({
      model: 'google/text-embedding-004',
      input: ['text1', 'text2'],
      encoding_format: 'float',
      dimensions: 768,
      safety_identifier: 'hash-abc',
      provider: { order: ['Google'] },
      input_type: 'search_document',
    });
    expect(result).not.toHaveProperty('output_dtype');
    expect(result).not.toHaveProperty('output_dimension');
  });

  it('should strip the deprecated user field', () => {
    const result = buildUpstreamBody({
      model: 'openai/text-embedding-3-small',
      input: 'hello',
      user: 'legacy-user-hash',
    });

    expect(result).toEqual({ model: 'openai/text-embedding-3-small', input: 'hello' });
    expect(result).not.toHaveProperty('user');
  });

  it('should pass through minimal body unchanged', () => {
    const result = buildUpstreamBody({
      model: 'openai/text-embedding-3-small',
      input: 'hello',
    });

    expect(result).toEqual({ model: 'openai/text-embedding-3-small', input: 'hello' });
  });

  it('should strip output_dtype and output_dimension even when other optional fields are absent', () => {
    const result = buildUpstreamBody({
      model: 'mistralai/mistral-embed-2312',
      input: 'hello',
      output_dtype: 'float',
      output_dimension: 512,
    });

    expect(result).toEqual({ model: 'mistralai/mistral-embed-2312', input: 'hello' });
    expect(result).not.toHaveProperty('output_dtype');
    expect(result).not.toHaveProperty('output_dimension');
  });
});
