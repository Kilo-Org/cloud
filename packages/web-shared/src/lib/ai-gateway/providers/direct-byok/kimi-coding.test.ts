import kimiCoding from './kimi-coding';

describe('Kimi Code direct BYOK provider', () => {
  it('exposes its coding model without recommending it', async () => {
    expect(await kimiCoding.models()).toMatchObject([
      {
        id: 'kimi-for-coding',
        name: 'Kimi for Coding',
        flags: ['vision', 'reasoning'],
        context_length: 262144,
        max_completion_tokens: 32768,
      },
    ]);
  });
});
