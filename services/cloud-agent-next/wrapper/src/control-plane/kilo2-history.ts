import { z } from 'zod';
import type { Harness } from './harness.js';
import { kilo2LocationQuery } from './kilo2-reads.js';
import { kilo2MessageSchema, type Kilo2Api } from './kilo2-api.js';
import { logToFile } from '../utils.js';

/** The native import budget. Older messages past it are not restored. */
export const MAX_RESTORE_MESSAGES = 1000;
const MAX_RESTORE_BYTES = 32 * 1024 * 1024;

const messageSchema = z.object({ message: kilo2MessageSchema, parentID: z.string().optional() });
const pageSchema = z.object({
  kind: z.literal('success'),
  source: z.object({ version: z.literal('v2'), session: z.object({ id: z.string() }) }),
  info: z.object({ id: z.string() }).passthrough(),
  messages: z.array(messageSchema),
  nextCursor: z.string().nullable(),
  omittedItemCount: z.number(),
});

/**
 * Restore native context from the Session DO's history, without v1 session-ingest.
 *
 * A gap does not fail the restore, because a failed restore makes the session
 * unable to open. Omitted rows and older messages past the budget are logged
 * and skipped.
 */
export async function restoreKilo2History(
  api: Kilo2Api,
  input: Parameters<Harness['open']>[0]
): Promise<boolean> {
  if (!input.readHistoryPage) return false;
  const signal = input.signal ?? AbortSignal.timeout(60_000);
  const messages: z.infer<typeof messageSchema>[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let bytes = 0;
  let omitted = 0;
  let truncated = false;
  const encoder = new TextEncoder();
  do {
    const data = await input.readHistoryPage(cursor);
    const header = pageSchema
      .omit({ source: true, messages: true })
      .extend({ source: z.object({ version: z.string() }), messages: z.array(z.unknown()) })
      .parse(data);
    if (header.info.id !== input.sessionId)
      throw new Error('Cloud history belongs to another native session');
    // A new Cloud chat has no native source until its first runtime opens it.
    // v1 history needs a separate migration, so its session starts empty.
    if (header.source.version !== 'v2') {
      if (header.messages.length || header.nextCursor !== null)
        logToFile(
          `kilo2 restore sessionId=${input.sessionId} phase=unsupported_source version=${header.source.version}`
        );
      break;
    }
    omitted += header.omittedItemCount;
    const page = pageSchema.parse(data);
    if (page.info.id !== input.sessionId || page.source.session.id !== input.sessionId)
      throw new Error('Cloud history belongs to another native session');
    // Pages run from newest to oldest, so the budget keeps the newest messages.
    for (const message of [...page.messages].sort((left, right) => order(right, left))) {
      const size = encoder.encode(JSON.stringify(message)).byteLength;
      truncated = messages.length === MAX_RESTORE_MESSAGES || bytes + size > MAX_RESTORE_BYTES;
      if (truncated) break;
      messages.push(message);
      bytes += size;
    }
    if (truncated) break;
    cursor = page.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error('Cloud history pagination did not advance');
    if (cursor) seen.add(cursor);
  } while (cursor);
  messages.sort(order);
  if (omitted > 0 || truncated) {
    // A partial history starts at a prompt, not at an answer whose prompt is missing.
    messages.splice(0, Math.max(0, messages.findIndex(isPrompt)));
    logToFile(
      `kilo2 restore sessionId=${input.sessionId} phase=partial omitted=${omitted} truncated=${truncated} restored=${messages.length}`
    );
  }
  if (!messages.length) return false;
  input.onRestore();
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

type RestoredMessage = z.infer<typeof messageSchema>;

function order(left: RestoredMessage, right: RestoredMessage): number {
  return (
    left.message.time.created - right.message.time.created ||
    left.message.id.localeCompare(right.message.id)
  );
}

/** A synthetic message is a prompt that Kilo wrote for the user. */
function isPrompt(message: RestoredMessage): boolean {
  return message.message.type === 'user' || message.message.type === 'synthetic';
}
