import tencentTokenPlan, { TENCENT_TOKEN_PLAN_MODELS } from './tencent-token-plan';
import { COMPATIBLE_USER_AGENT } from './types';

describe('Tencent Token Plan direct BYOK provider', () => {
  it('uses the international OpenAI-compatible Token Plan endpoint', () => {
    expect(tencentTokenPlan).toMatchObject({
      id: 'tencent-token-plan',
      base_url: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3',
      supported_chat_apis: ['chat_completions'],
      default_ai_sdk_provider: 'openai-compatible',
    });
  });

  it('identifies gateway requests as Kilo Code', () => {
    const context = { extraHeaders: {} } as Parameters<typeof tencentTokenPlan.transformRequest>[0];

    tencentTokenPlan.transformRequest(context);

    expect(context.extraHeaders['user-agent']).toBe(COMPATIBLE_USER_AGENT);
  });

  it('exposes the Personal Token Plan model catalog', async () => {
    const models = await tencentTokenPlan.models();

    expect(models).toBe(TENCENT_TOKEN_PLAN_MODELS);
    expect(models.map(model => model.id)).toEqual([
      'auto',
      'glm-5.2',
      'kimi-k2.6',
      'minimax-m3',
      'deepseek-v4-flash-202605',
      'deepseek-v4-pro-202606',
    ]);
    expect(models.find(model => model.id === 'glm-5.2')).toMatchObject({
      flags: expect.arrayContaining(['recommended', 'reasoning']),
      context_length: 1_048_576,
      max_completion_tokens: 131_072,
    });
    expect(models.find(model => model.id === 'kimi-k2.6')).toMatchObject({
      flags: expect.arrayContaining(['vision', 'reasoning']),
      context_length: 262_144,
      max_completion_tokens: 262_144,
    });
  });
});
