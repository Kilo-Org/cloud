import { z } from 'zod';
import type { Harness } from './harness.js';
import { kilo2LocationQuery } from './kilo2-reads.js';
import { kilo2MessageSchema, type Kilo2Api } from './kilo2-api.js';

const messageSchema = z.object({ message: kilo2MessageSchema, parentID: z.string().optional() });
const pageSchema = z.object({
  kind: z.literal('success'),
  source: z.object({ version: z.literal('v2'), session: z.object({ id: z.string() }) }),
  info: z.object({ id: z.string() }).passthrough(),
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
  omittedItemCount: z.number(),
});

/** Restore native context from the local Session DO, without v1 session-ingest. */
export async function restoreKilo2History(
  api: Kilo2Api,
  input: Parameters<Harness['open']>[0]
): Promise<boolean> {
  if (!input.cloudSessionId) return false;
  const control = new URL(process.env.SANDBOX_CONTROL_URL ?? '');
  if (!['localhost', '127.0.0.1', 'host.docker.internal', '[::1]'].includes(control.hostname))
    throw new Error('Kilo v2 history recovery requires a local Cloud Agent Worker');
  control.protocol =
    control.protocol === 'wss:' || control.protocol === 'https:' ? 'https:' : 'http:';
  const token = z
    .object({ kilo: z.object({ key: z.string().optional(), access: z.string().optional() }) })
    .parse(JSON.parse(input.env.KILO_AUTH_CONTENT ?? '{}')).kilo;
  const bearer = token.key ?? token.access;
  if (!bearer) throw new Error('Kilo v2 history recovery requires the current route credential');
  const signal = input.signal ?? AbortSignal.timeout(60_000);
  const messages: z.infer<typeof messageSchema>[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let bytes = 0;
  do {
    const url = new URL('/api/runtime-credential-proxy/history/page', control);
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        limit: 100,
        ...(cursor ? { cursor } : {}),
        rootNativeId: input.sessionId,
      }),
      signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`Local Cloud history read failed: HTTP ${response.status}`);
    const data: unknown = await response.json();
    const header = pageSchema
      .omit({ source: true, messages: true })
      .extend({ messages: z.array(z.unknown()) })
      .parse(data);
    if (header.info.id !== input.sessionId)
      throw new Error('Local Cloud history belongs to another native session');
    if (header.omittedItemCount !== 0) throw new Error('Local Cloud history is incomplete');
    // A new Cloud chat has no native source until its first runtime opens it.
    if (!messages.length && !header.messages.length && header.nextCursor === null) return false;
    const page = pageSchema.parse(data);
    if (page.info.id !== input.sessionId || page.source.session.id !== input.sessionId)
      throw new Error('Local Cloud history belongs to another native session');
    if (page.omittedItemCount !== 0) throw new Error('Local Cloud history is incomplete');
    messages.push(...page.messages);
    bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
    if (messages.length > 1000 || bytes > 32 * 1024 * 1024)
      throw new Error('Local Cloud history exceeds the native restore budget');
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor))
      throw new Error('Local Cloud history pagination did not advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
  if (!messages.length) return false;
  input.onRestore();
  messages.sort(
    (left, right) =>
      left.message.time.created - right.message.time.created ||
      left.message.id.localeCompare(right.message.id)
  );
  const location = z
    .object({ project: z.object({ id: z.string() }) })
    .parse(await api.request(`/api/location?${kilo2LocationQuery(input.directory)}`, { signal }));
  const time = messages[0].message.time.created;
  const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  let cost = 0;
  for (const message of messages) {
    cost += message.message.cost ?? 0;
    if (!message.message.tokens) continue;
    tokens.input += message.message.tokens.input;
    tokens.output += message.message.tokens.output;
    tokens.reasoning += message.message.tokens.reasoning;
    tokens.cache.read += message.message.tokens.cache.read;
    tokens.cache.write += message.message.tokens.cache.write;
  }
  await api.request('/api/experimental/session/import', {
    method: 'POST',
    signal,
    body: {
      location: { directory: input.directory },
      info: {
        id: input.sessionId,
        projectID: location.project.id,
        location: { directory: input.directory },
        cost,
        tokens,
        time: {
          created: time,
          updated:
            messages.at(-1)?.message.time.completed ??
            messages.at(-1)?.message.time.created ??
            time,
        },
      },
      messages: messages.map(message => message.message),
    },
  });
  return true;
}
