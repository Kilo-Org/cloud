import 'dotenv/config';
import OpenAI from 'openai';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources';

async function main() {
  // Get API key from command-line argument or environment variable
  const anthropicApiKey = process.argv[2];

  if (!anthropicApiKey) {
    console.error(
      'Error: Anthropic API key is required.\n' +
        'Provide it as a command-line argument or set ANTHROPIC_API_KEY environment variable.\n' +
        'Usage: npx tsx src/scripts/byok/test.ts <api-key>'
    );
    process.exit(1);
  }

  const openai = new OpenAI({
    apiKey: PROVIDERS.VERCEL_AI_GATEWAY.apiKey,
    baseURL: PROVIDERS.VERCEL_AI_GATEWAY.apiUrl,
  });

  const stream = (await openai.chat.completions.create({
    model: 'anthropic/claude-sonnet-4.5',
    messages: [
      {
        role: 'user',
        content: 'Say hello as a pirate',
      },
    ],
    stream: true,
    providerOptions: {
      gateway: {
        only: ['anthropic'],
        byok: {
          anthropic: [
            {
              apiKey: anthropicApiKey,
            },
          ],
        },
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as unknown as Stream<ChatCompletionChunk>;

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      process.stdout.write(content);
    } else {
      console.log('chunk', JSON.stringify(chunk, null, 2));
    }
  }
}

export async function run() {
  await main();
}
