import { describe, it, expect } from '@jest/globals';
import { buildUpstreamBody, validateEmbeddingDimensions } from './embedding-request';

describe('buildUpstreamBody', () => {
  it('should forward supported fields and strip native Mistral fields', () => {
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

  it.each([
    ['mistralai/codestral-embed-2505', 1536],
    ['mistralai/mistral-embed-2312', 1024],
    ['openai/text-embedding-ada-002', 1536],
    ['baai/bge-large-en-v1.5', 1024],
    ['baai/bge-base-en-v1.5', 768],
  ])('should omit catalog dimensions for fixed model %s', (model, dimensions) => {
    const result = buildUpstreamBody({
      model,
      input: ['function add(a, b) { return a + b; }'],
      dimensions,
    });

    expect(result).toEqual({
      model,
      input: ['function add(a, b) { return a + b; }'],
    });
  });

  it.each([
    ['openai/text-embedding-3-small', 1536],
    ['google/gemini-embedding-001', 3072],
  ])('should keep catalog dimensions for model %s without a fixed policy', (model, dimensions) => {
    expect(buildUpstreamBody({ model, input: 'hello', dimensions })).toEqual({
      model,
      input: 'hello',
      dimensions,
    });
  });

  it('should apply fixed model handling after an upstream model ID rewrite', () => {
    expect(
      buildUpstreamBody(
        { model: 'mistral/codestral-embed', input: 'hello', dimensions: 1536 },
        'mistralai/codestral-embed-2505'
      )
    ).toEqual({ model: 'mistral/codestral-embed', input: 'hello' });
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

  it('should reject a non-native dimension for a fixed model before proxying', () => {
    expect(
      validateEmbeddingDimensions({
        model: 'codestral-embed-2505',
        input: 'hello',
        dimensions: 256,
      })
    ).toContain('fixed 1536-dimensional embeddings');
    expect(
      validateEmbeddingDimensions({
        model: 'mistralai/codestral-embed-2505',
        input: 'hello',
        dimensions: 1536,
      })
    ).toBeUndefined();
  });

  it('should not reject a catalog dimension for a model without a fixed policy', () => {
    expect(
      validateEmbeddingDimensions({
        model: 'google/gemini-embedding-001',
        input: 'hello',
        dimensions: 3072,
      })
    ).toBeUndefined();
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
