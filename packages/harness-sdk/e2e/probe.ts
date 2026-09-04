/**
 * Prints the raw frames of one call, for finding out what a shape actually
 * sends. It asserts nothing and is not part of any suite: it exists so a
 * question about the wire can be answered by reading the wire.
 *
 * `pnpm test:e2e:probe [shape] [model]`
 */
import { kiloToken, nodeFetch } from './node-fetch.js';

const baseUrl = process.env['KILO_BASE_URL'] ?? 'https://app.kilo.ai';
const organizationId = process.env['KILO_ORG_ID'] ?? '9d278969-5453-4ae3-a51f-a8d2274a7b56';

const paths = {
  messages: '/api/gateway/v1/messages',
  responses: '/api/gateway/v1/responses',
  chat_completions: '/api/gateway/v1/chat/completions',
} as const;

const shape = (process.argv[2] ?? 'responses') as keyof typeof paths;
const model = process.argv[3] ?? 'openai/gpt-5.6-luna';
const question = 'A farmer has 17 sheep. All but 9 run away. How many are left?';

const bodies: Readonly<Record<keyof typeof paths, unknown>> = {
  messages: {
    model,
    max_tokens: 2000,
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
  },
  responses: {
    model,
    max_output_tokens: 2000,
    stream: true,
    reasoning: { effort: 'medium' },
    include: ['reasoning.encrypted_content'],
    store: false,
    input: [{ role: 'user', content: [{ type: 'input_text', text: question }] }],
  },
  chat_completions: {
    model,
    max_tokens: 2000,
    stream: true,
    reasoning: { effort: 'medium' },
    messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
  },
};

const response = await nodeFetch(`${baseUrl}${paths[shape]}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${await kiloToken()}`,
    'x-kilocode-organizationid': organizationId,
  },
  body: JSON.stringify(bodies[shape]),
});

console.log(shape, model, response.status);
if (!response.ok || response.stream === undefined) {
  console.log(await response.text());
  process.exit(1);
}

/** Only the frame names and the fields that are not the answer's text. */
const seen = new Map<string, number>();
let held = '';
for await (const chunk of response.stream()) {
  held += chunk;
  const lines = held.split('\n');
  held = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const data = line.slice(6);
    if (data === '[DONE]') {
      continue;
    }
    const event: unknown = JSON.parse(data);
    const named = event as { type?: string };
    const name = named.type ?? 'unnamed';
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (name.includes('reasoning') || name.includes('item') || name === 'unnamed') {
      console.log(name, JSON.stringify(event).slice(0, Number(process.env['PROBE_WIDTH'] ?? 300)));
    }
  }
}

console.log('\nframes:');
for (const [name, count] of [...seen].sort()) {
  console.log(' ', String(count).padStart(4), name);
}
