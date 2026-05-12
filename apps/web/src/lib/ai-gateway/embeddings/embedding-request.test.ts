import { describe, it, expect } from '@jest/globals';
import { buildDownstreamResponse, buildUpstreamBody } from './embedding-request';

describe('buildUpstreamBody', () => {
  it('should forward supported fields and strip client-only, SDK-only, Mistral-specific, and deprecated fields', () => {
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
      safety_identifier: 'hash-abc',
      provider: { order: ['Google'] },
      input_type: 'search_document',
    });
    expect(result).not.toHaveProperty('dimensions');
    expect(result).not.toHaveProperty('encoding_format');
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

describe('buildDownstreamResponse', () => {
  it('converts numeric embeddings to base64 when the client requested base64', async () => {
    const response = new Response(
      JSON.stringify({
        data: [
          { object: 'embedding', embedding: [1, 2, 3], index: 0 },
          { object: 'embedding', embedding: [4, 5, 6], index: 1 },
        ],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );

    const result = await buildDownstreamResponse(response, 'base64');
    const body = await result.json();

    expect(body.data[0].embedding).toBe(
      Buffer.from(new Float32Array([1, 2, 3]).buffer).toString('base64')
    );
    expect(body.data[1].embedding).toBe(
      Buffer.from(new Float32Array([4, 5, 6]).buffer).toString('base64')
    );
    expect(body.usage).toEqual({ prompt_tokens: 1, total_tokens: 1 });
  });

  it('leaves responses unchanged when base64 was not requested', async () => {
    const response = new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

    const result = await buildDownstreamResponse(response, undefined);

    expect(result).toBe(response);
  });

  it('leaves error responses unchanged', async () => {
    const response = new Response('Bad Request', { status: 400 });

    const result = await buildDownstreamResponse(response, 'base64');

    expect(result).toBe(response);
  });
});
