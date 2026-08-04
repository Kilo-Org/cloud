import byteplusCoding from './byteplus-coding';

describe('BytePlus Coding direct BYOK provider', () => {
  it('exposes exactly the approved Coding Plan models', async () => {
    const models = await byteplusCoding.models();

    expect(models.map(model => model.id)).toEqual([
      'bytedance-seed-code',
      'kimi-k2.5',
      'glm-5.1',
      'glm-5.2',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'gpt-oss-120b',
      'dola-seed-2.0-code',
      'dola-seed-2.0-pro',
      'dola-seed-2.0-lite',
    ]);
    expect(models.find(model => model.id === 'bytedance-seed-code')).toMatchObject({
      name: 'ByteDance-Seed-Code',
      flags: expect.arrayContaining(['recommended', 'vision']),
      context_length: 262144,
    });
  });
});
