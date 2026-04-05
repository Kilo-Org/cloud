import { NextResponse } from 'next/server';

// this route is called by the old extension and should be removed when that's no longer relevant

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    [
      {
        model: 'anthropic/claude-sonnet-4.6',
        cost: 0.846767394336771,
        costPerRequest: 0.070754096351306,
      },
      {
        model: 'anthropic/claude-opus-4.6',
        cost: 1.55365784946837,
        costPerRequest: 0.130604072185604,
      },
      {
        model: 'moonshotai/kimi-k2.5',
        cost: 0.214675457234356,
        costPerRequest: 0.0114873104764894,
      },
      {
        model: 'mistralai/codestral-2508',
        cost: 0.333515482097396,
        costPerRequest: 0.000338961128634318,
      },
      {
        model: 'minimax/minimax-m2.5',
        cost: 0.072531479863115,
        costPerRequest: 0.00359489406140943,
      },
      {
        model: 'openai/gpt-5.4',
        cost: 1.05938032698464,
        costPerRequest: 0.0800828164797871,
      },
      {
        model: 'z-ai/glm-5',
        cost: 0.544525793287878,
        costPerRequest: 0.0291657886637883,
      },
      {
        model: 'google/gemini-3-flash-preview',
        cost: 0.14158623443696,
        costPerRequest: 0.00928399827774916,
      },
      {
        model: 'openai/gpt-5.3-codex',
        cost: 0.502784256000412,
        costPerRequest: 0.0330453591626738,
      },
      {
        model: 'anthropic/claude-sonnet-4.5',
        cost: 1.0952696972131,
        costPerRequest: 0.0684410014268817,
      },
      {
        model: 'google/gemini-3.1-pro-preview',
        cost: 0.677759639836085,
        costPerRequest: 0.0479179215435795,
      },
      {
        model: 'openai/gpt-5.2',
        cost: 0.641043727671249,
        costPerRequest: 0.0512261149389567,
      },
      {
        model: 'anthropic/claude-haiku-4.5',
        cost: 0.290612066742809,
        costPerRequest: 0.0120709667810904,
      },
      {
        model: 'anthropic/claude-opus-4.5',
        cost: 1.32819000095615,
        costPerRequest: 0.0811113228778853,
      },
      {
        model: 'deepseek/deepseek-v3.2',
        cost: 0.329440034263849,
        costPerRequest: 0.000688943460271701,
      },
      {
        model: 'x-ai/grok-code-fast-1',
        cost: 0.0954966245259583,
        costPerRequest: 0.00296342818316847,
      },
      {
        model: 'google/gemini-3.1-flash-lite-preview',
        cost: 0.103909578441381,
        costPerRequest: 0.00476114148455162,
      },
      {
        model: 'z-ai/glm-4.7',
        cost: 0.192176216923057,
        costPerRequest: 0.0108634020976264,
      },
      {
        model: 'openai/gpt-5.2-codex',
        cost: 0.527951148664293,
        costPerRequest: 0.028424518611591,
      },
      {
        model: 'qwen/qwen3.5-plus-02-15',
        cost: 0.286177652335367,
        costPerRequest: 0.0281050647026929,
      },
      {
        model: 'google/gemini-3-pro-preview',
        cost: 0.983384103361623,
        costPerRequest: 0.054375204803884,
      },
      {
        model: 'openai/gpt-5.1-codex-mini',
        cost: 0.0574721986332689,
        costPerRequest: 0.00515548096983366,
      },
      {
        model: 'x-ai/grok-4.1-fast',
        cost: 0.17290085084366,
        costPerRequest: 0.00843407953394124,
      },
      {
        model: 'google/gemini-2.5-pro',
        cost: 0.818812557167088,
        costPerRequest: 0.0482036552872606,
      },
      {
        model: 'openai/gpt-5-nano',
        cost: 0.100442443162043,
        costPerRequest: 0.000652833195288054,
      },
      {
        model: 'x-ai/grok-4.20-multi-agent-beta',
        cost: 0.900486444666042,
        costPerRequest: 1.47391943712575,
      },
      {
        model: 'qwen/qwen3.5-397b-a17b',
        cost: 0.624334373777358,
        costPerRequest: 0.0396576827417381,
      },
      {
        model: 'deepseek/deepseek-v3.2-exp',
        cost: 0.270817363930573,
        costPerRequest: 0.0176300637663886,
      },
      {
        model: 'qwen/qwen3-coder-next',
        cost: 0.207433976677795,
        costPerRequest: 0.0114250334386519,
      },
      {
        model: 'anthropic/claude-sonnet-4',
        cost: 0.849554359991956,
        costPerRequest: 0.0314523194621116,
      },
    ],
    {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    }
  );
}
