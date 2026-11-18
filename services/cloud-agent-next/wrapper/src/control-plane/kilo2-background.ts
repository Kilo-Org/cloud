import { z } from 'zod';
import {
  backgroundJobSchema,
  backgroundActivityInventorySchema,
} from '../../../src/shared/background-activity.js';
import type { Kilo2Api } from './kilo2-api.js';
import { createKilo2Reads, kilo2LocationQuery } from './kilo2-reads.js';

const LIMIT = 256;
const shellListSchema = z.array(z.object({ id: z.string(), status: z.string() }));

export async function readKilo2BackgroundActivity(
  api: Kilo2Api,
  sessionID: string,
  directory: string,
  signal: AbortSignal
) {
  const { reads, session } = createKilo2Reads(api, directory);
  async function readJobs() {
    const query = new URLSearchParams({ sessionID, descendants: 'true', status: 'running' });
    const raw = await api.data(`/api/experimental/job?${query}`, { signal });
    const jobs = z
      .array(z.unknown())
      .parse(raw)
      .flatMap(entry => {
        const job = backgroundJobSchema.safeParse(entry);
        return job.success ? [job.data] : [];
      });
    if (!jobs.some(job => job.kind === 'shell')) return jobs;

    let shells: z.infer<typeof shellListSchema>;
    try {
      shells = shellListSchema.parse(
        await api.data(`/api/shell?${kilo2LocationQuery(directory)}`, { signal })
      );
    } catch {
      signal.throwIfAborted();
      return jobs.filter(job => job.kind !== 'shell');
    }
    const liveShells = new Set(
      shells.filter(shell => shell.status === 'running').map(shell => shell.id)
    );
    return jobs.filter(job => job.kind !== 'shell' || liveShells.has(job.shellID));
  }

  const [readable, questions, permissions] = await Promise.all([
    readJobs(),
    reads.getQuestions(directory, signal),
    reads.getPermissions(directory, signal),
  ]);
  const sessions = new Map<string, Awaited<ReturnType<typeof session>>>();
  const root = await session(sessionID, signal);
  if (root.location.directory !== directory)
    throw new Error('Background activity directory mismatch');
  sessions.set(sessionID, root);
  async function owns(id: string, seen = new Set<string>()): Promise<boolean> {
    if (id === sessionID) return true;
    if (seen.has(id) || seen.size >= 32) return false;
    seen.add(id);
    let info = sessions.get(id);
    if (!info) {
      if (sessions.size >= LIMIT) return false;
      info = await session(id, signal);
      sessions.set(id, info);
    }
    return (
      info.location.directory === directory && !!info.parentID && (await owns(info.parentID, seen))
    );
  }
  const jobs = [];
  for (const job of readable) {
    if (jobs.length >= LIMIT) break;
    if (!(await owns(job.sessionID))) continue;
    if (
      job.kind === 'subagent' &&
      (!(await owns(job.childSessionID)) ||
        sessions.get(job.childSessionID)?.parentID !== job.sessionID)
    )
      continue;
    jobs.push(job);
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
  return backgroundActivityInventorySchema.parse({
    sessionID,
    jobs,
    sessions: owned.slice(0, LIMIT),
    waits: waits.slice(0, LIMIT),
  });
}
