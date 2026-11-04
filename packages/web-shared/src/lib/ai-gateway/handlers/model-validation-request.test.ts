import { describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { parseModelValidationRequest } from './model-validation-request';

function request(body: string) {
  return new NextRequest('http://localhost:3000/api/openrouter/models/validate', {
    method: 'POST',
    body,
  });
}

async function expectRejected(body: string) {
  const result = await parseModelValidationRequest(request(body));
  if (result.success) throw new Error('expected request to be rejected');
  expect(result.response.status).toBe(400);
  return result.response.json();
}

describe('parseModelValidationRequest', () => {
  test('trims the model ID', async () => {
    await expect(
      parseModelValidationRequest(request(JSON.stringify({ modelId: '  vendor/model  ' })))
    ).resolves.toEqual({ success: true, data: { modelId: 'vendor/model' } });
  });

  test('rejects malformed JSON', async () => {
    await expect(expectRejected('{not json')).resolves.toEqual({ error: 'Invalid JSON body' });
  });

  test.each([
    ['missing', {}],
    ['non-string', { modelId: 42 }],
    ['blank', { modelId: '   ' }],
  ])('rejects a %s model ID with tree-shaped details', async (_name, body) => {
    const json = await expectRejected(JSON.stringify(body));
    expect(json).toEqual({
      error: 'Invalid request body',
      details: {
        errors: [],
        properties: { modelId: { errors: [expect.any(String)] } },
      },
    });
  });
});
