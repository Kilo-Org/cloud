import { z } from 'zod';
import {
  backgroundJobSchema,
  backgroundActivityInventorySchema,
} from '@kilocode/session-ingest-contracts';
import type { Kilo2Api } from './kilo2-api.js';
import { createKilo2Reads } from './kilo2-reads.js';

const inventorySchema = z
  .array(z.union([backgroundJobSchema, z.object({ kind: z.literal('image') })]))
  .max(256);

export async function readKilo2BackgroundActivity(
  api: Kilo2Api,
  sessionID: string,
  directory: string,
  signal: AbortSignal
) {
  const { reads, session } = createKilo2Reads(api, directory);
  const query = new URLSearchParams({ sessionID, descendants: 'true', status: 'running' });
  const [raw, questions, permissions] = await Promise.all([
    api.data(`/api/experimental/job?${query}`, { signal }),
    reads.getQuestions(directory, signal),
    reads.getPermissions(directory, signal),
  ]);
  const jobs = inventorySchema.parse(raw).filter(job => job.kind !== 'image');
  const sessions = new Map<string, Awaited<ReturnType<typeof session>>>();
  const root = await session(sessionID, signal);
  if (root.location.directory !== directory)
    throw new Error('Background activity directory mismatch');
  sessions.set(sessionID, root);
  async function owns(id: string, seen = new Set<string>()): Promise<boolean> {
    if (id === sessionID) return true;
    if (seen.has(id) || seen.size >= 32 || sessions.size >= 256)
      throw new Error('Background activity lineage exceeds its bound');
    seen.add(id);
    const info = sessions.get(id) ?? (await session(id, signal));
    sessions.set(id, info);
    return (
      info.location.directory === directory && !!info.parentID && (await owns(info.parentID, seen))
    );
  }
  for (const job of jobs) {
    if (!(await owns(job.sessionID))) throw new Error('Background job belongs to another chat');
    if (job.kind === 'subagent') {
      if (
        !(await owns(job.childSessionID)) ||
        sessions.get(job.childSessionID)?.parentID !== job.sessionID
      )
        throw new Error('Background agent lineage mismatch');
    }
  }
  const waits: Array<{ sessionID: string; kind: 'question' | 'permission' }> = [];
  for (const [kind, requests] of [
    ['question', questions],
    ['permission', permissions],
  ] as const) {
    for (const request of requests) {
      if (await owns(request.sessionID)) waits.push({ sessionID: request.sessionID, kind });
    }
  }
  const owned = [];
  for (const info of sessions.values()) {
    if (await owns(info.id))
      owned.push({
        id: info.id,
        ...(info.parentID ? { parentID: info.parentID } : {}),
        ...(info.title ? { title: info.title } : {}),
      });
  }
  return backgroundActivityInventorySchema.parse({ sessionID, jobs, sessions: owned, waits });
}
