/**
 * Seeds the local `ai_gateway_metadata_cache` with a deterministic OpenRouter-shaped catalog:
 * 120 listed models plus two Z.ai models that retire within the note window (3 days out),
 * so the mobile catalog shows the retirement note. Local dev DB only.
 */
import { ai_gateway_metadata_cache } from '@kilocode/db/schema';
import { getSeedDb, closeSeedDb, assertLocalSeedDatabase } from '../seed/lib/db';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

function day(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function entry(i: number) {
  const provider = `vendor${i % 12}`;
  return {
    id: `${provider}/model-${i}`,
    name: `Vendor${i % 12}: Model ${i}`,
    created: Math.floor(Date.now() / 1000) - 90 * 24 * 3600,
    description: `Fixture model ${i}.`,
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false, context_length: 32000, max_completion_tokens: 8000 },
    pricing: { prompt: '0.000001', completion: '0.000001', request: '0' },
    context_length: 32000,
    supported_parameters: ['max_tokens', 'temperature'],
  };
}

const data = {
  data: [
    ...Array.from({ length: 120 }, (_, i) => entry(i)),
    {
      ...entry(900),
      id: 'z-ai/glm-5.1',
      name: 'Z.ai: GLM 5.1',
      created: Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
      expiration_date: day(3),
    },
    {
      ...entry(901),
      id: 'z-ai/glm-5.1-beyond',
      name: 'Z.ai: GLM Far',
      created: Math.floor(Date.now() / 1000) - 30 * 24 * 3600,
      expiration_date: day(45),
    },
  ],
};

assertLocalSeedDatabase('seed-retire-catalog');
const db = getSeedDb();
await db
  .insert(ai_gateway_metadata_cache)
  .values({ url: OPENROUTER_MODELS_URL, data })
  .onConflictDoUpdate({ target: ai_gateway_metadata_cache.url, set: { data } });
console.log(`seeded ${data.data.length} models at ${OPENROUTER_MODELS_URL}, retiring := ${day(3)}`);
await closeSeedDb();
