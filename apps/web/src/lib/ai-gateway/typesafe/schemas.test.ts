import { describe, expect, it } from '@jest/globals';
import { choice, noul, score } from '@typesafe-ai/sdk';
import { systemOneRequestSchema, systemOneResponseSchema, TYPESAFE_MODEL } from './schemas';

describe('systemOneRequestSchema', () => {
  it('accepts SDK question helpers with structured entries and strips routing overrides', () => {
    const request = {
      state: { text: 'A support request', metadata: [1, true, null] },
      questions: {
        relevant: noul({ prompt: 'Is this relevant?' }, { true: ['Yes'], false: null }),
        category: choice(null, { billing: { description: 'Payments' }, other: null }),
        urgency: score(['Assess urgency'], [null, 'Medium', { description: 'High' }]),
      },
    };

    expect(
      systemOneRequestSchema.parse({
        ...request,
        model: 'jev-1.13',
        provider: { only: ['attacker'] },
        api_key: 'test-key',
        user: 'attacker',
      })
    ).toEqual({ ...request, model: TYPESAFE_MODEL, provider: {} });
  });

  it('accepts only provider privacy fields', () => {
    const provider = { data_collection: 'deny', zdr: false };
    const request = { state: null, questions: { relevant: { type: 'noul' } } };

    expect(
      systemOneRequestSchema.parse({
        ...request,
        provider: {
          ...provider,
          only: ['attacker'],
          api_key: 'test-key',
          user_byok: [{ providerId: 'typesafe', apiKey: 'test-key' }],
        },
      })
    ).toEqual({ ...request, model: TYPESAFE_MODEL, provider });
  });

  it('does not default provider privacy', () => {
    const request = { state: null, questions: { relevant: { type: 'noul' } } };

    expect(systemOneRequestSchema.parse(request)).toEqual({ ...request, model: TYPESAFE_MODEL });
  });

  it.each([
    { provider: null },
    { provider: { data_collection: 'invalid' } },
    { provider: { zdr: 'true' } },
  ])('rejects malformed provider privacy: %j', ({ provider }) => {
    expect(
      systemOneRequestSchema.safeParse({
        state: null,
        questions: { relevant: { type: 'noul' } },
        provider,
      }).success
    ).toBe(false);
  });

  it.each(['text', { nested: [true, 1, null] }, ['text', 1, false], null])(
    'accepts SDK state entries: %j',
    state => {
      expect(
        systemOneRequestSchema.safeParse({ state, questions: { relevant: { type: 'noul' } } })
          .success
      ).toBe(true);
    }
  );

  it.each([
    ['missing state', { questions: { relevant: { type: 'noul' } } }],
    ['numeric state', { state: 1, questions: { relevant: { type: 'noul' } } }],
    ['boolean state', { state: true, questions: { relevant: { type: 'noul' } } }],
    ['unknown question type', { state: null, questions: { q: { type: 'boolean' } } }],
    ['missing choice criteria', { state: null, questions: { q: { type: 'choice' } } }],
    [
      'array choice criteria',
      { state: null, questions: { q: { type: 'choice', criteria: ['a', 'b'] } } },
    ],
    ['short score rubric', { state: null, questions: { q: { type: 'score', criteria: ['Low'] } } }],
    [
      'object score rubric',
      {
        state: null,
        questions: { q: { type: 'score', criteria: { '0': 'Low', '1': 'High' } } },
      },
    ],
  ])('rejects %s', (_name, request) => {
    expect(systemOneRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('systemOneResponseSchema', () => {
  const response = {
    id: 'gen-123',
    model: TYPESAFE_MODEL,
    answers: { relevant: { type: 'noul', noul: 0.5 } },
    usage: { input_tokens: 1, output_tokens: 2, cost: 0.00001 },
  };

  it('retains upstream metadata, usage extensions, and answer extensions', () => {
    const extended = {
      ...response,
      provider: 'TypeSafe',
      metadata: { request_id: 'upstream-123' },
      answers: { relevant: { type: 'noul', noul: 1, explanation: 'Relevant' } },
      usage: { input_tokens: 0, output_tokens: 0, cost: 0, total_tokens: 0 },
    };

    expect(systemOneResponseSchema.parse(extended)).toEqual(extended);
  });

  it.each([NaN, Infinity, -Infinity])('rejects non-finite upstream cost %s', cost => {
    expect(
      systemOneResponseSchema.safeParse({ ...response, usage: { ...response.usage, cost } }).success
    ).toBe(false);
  });

  it.each([
    ['missing generation ID', { ...response, id: undefined }],
    ['empty generation ID', { ...response, id: '' }],
    ['missing model', { ...response, model: undefined }],
    ['empty model', { ...response, model: '' }],
    ['missing answers', { ...response, answers: undefined }],
  ])('rejects %s', (_name, value) => {
    expect(systemOneResponseSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    { type: 'noul', noul: -0.1 },
    { type: 'noul', noul: 1.1 },
    { type: 'noul', noul: '0.5' },
    { type: 'unknown', noul: 0.5 },
    { type: 'choice', choice: 'yes', confidence: 1.1, probabilities: { yes: 1 } },
    { type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: -0.1 } },
    { type: 'score', score: -1, confidence: 1, probabilities: { '0': 1 }, legend: { '0': 'Low' } },
    { type: 'score', score: 0, confidence: 1, probabilities: { '0': 1 } },
  ])('rejects malformed answers: %j', answer => {
    expect(
      systemOneResponseSchema.safeParse({ ...response, answers: { relevant: answer } }).success
    ).toBe(false);
  });
});
