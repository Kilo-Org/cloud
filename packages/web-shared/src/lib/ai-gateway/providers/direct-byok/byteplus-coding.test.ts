import { REASONING_TOGGLE } from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import byteplusCoding, { BYTEPLUS_CODING_MODEL_IDS } from './byteplus-coding';
import { formatDirectByokModelId } from './index';

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
      flags: ['vision', 'reasoning'],
      context_length: 262144,
    });
  });

  it('exports the canonical id of every model', async () => {
    const models = await byteplusCoding.models();

    expect(BYTEPLUS_CODING_MODEL_IDS).toEqual(
      models.map(model => formatDirectByokModelId(byteplusCoding, model))
    );
  });

  it('declares the reasoning toggle on the gpt-oss-120b entry', async () => {
    const models = await byteplusCoding.models();

    expect(models.find(model => model.id === 'gpt-oss-120b')?.reasoning_options).toBe(
      REASONING_TOGGLE
    );
  });
});
