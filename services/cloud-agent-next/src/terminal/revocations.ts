import { z } from 'zod';
import type { SandboxTerminalRecord } from '../sandbox-session/terminal-bridge.js';

const PREFIX = 'control_terminal_revocation:';
const RETRY_MS = 5_000;
const WRAPPER_PROBE_MS = 30_000;
const WRAPPER_PROBE_BUDGET_MS = 5 * 60_000;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 5_000;

async function bounded<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const pendingSchema = z.object({
  ptyId: z.string().min(1),
  wrapperId: z.string().min(1),
  sandboxId: z.string().min(1),
  session: z.object({ sessionId: z.string(), kiloSessionId: z.string(), directory: z.string() }),
  attempts: z.number().int().min(0).max(MAX_ATTEMPTS),
  nextAt: z.number().int().nonnegative().nullable(),
  probeUntil: z.number().int().nonnegative().optional(),
});
type Pending = z.infer<typeof pendingSchema>;
export type TerminalRevocation = Omit<Pending, 'attempts' | 'nextAt' | 'probeUntil'>;
type Deps = {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  getWrapperId: () => Promise<string | undefined>;
  closeTerminal: (target: TerminalRevocation) => Promise<boolean>;
  reportUnconfirmed: (ptyId: string) => void;
};

/** Socket revocation is immediate; these durable obligations track actual PTY closure. */
export function createTerminalRevocations(deps: Deps) {
  let draining: Promise<void> | undefined;

  async function pending(): Promise<Pending[]> {
    const rows = await deps.storage.list<unknown>({ prefix: PREFIX });
    const result: Pending[] = [];
    for (const [key, value] of rows) {
      const parsed = pendingSchema.safeParse(value);
      if (parsed.success && key === `${PREFIX}${parsed.data.ptyId}`) result.push(parsed.data);
    }
    return result;
  }

  async function enqueue(record: SandboxTerminalRecord): Promise<void> {
    const key = `${PREFIX}${record.ptyId}`;
    const existing = pendingSchema.safeParse(await deps.storage.get<unknown>(key));
    if (existing.success && existing.data.wrapperId === record.wrapperId) return;
    await deps.storage.put(key, {
      ptyId: record.ptyId,
      wrapperId: record.wrapperId,
      sandboxId: record.sandboxId,
      session: {
        sessionId: record.sessionId,
        kiloSessionId: record.kiloSessionId,
        directory: record.directory,
      },
      attempts: 0,
      nextAt: Date.now(),
    } satisfies Pending);
  }

  async function performDrain(): Promise<void> {
    for (const item of await pending()) {
      const key = `${PREFIX}${item.ptyId}`;
      let wrapperId: string | undefined;
      try {
        wrapperId = await bounded(deps.getWrapperId());
      } catch {
        wrapperId = undefined;
      }
      if (wrapperId !== undefined && wrapperId !== item.wrapperId) {
        await deps.storage.delete(key);
        continue;
      }
      if (item.attempts === MAX_ATTEMPTS || (item.nextAt !== null && item.nextAt > Date.now()))
        continue;
      if (wrapperId === undefined) {
        const probeUntil = item.probeUntil ?? Date.now() + WRAPPER_PROBE_BUDGET_MS;
        if (Date.now() >= probeUntil) {
          if (item.nextAt !== null) {
            await deps.storage.put(key, { ...item, probeUntil, nextAt: null } satisfies Pending);
            deps.reportUnconfirmed(item.ptyId);
          }
          continue;
        }
        // Outages do not consume close attempts or keep the alarm alive indefinitely.
        await deps.storage.put(key, {
          ...item,
          probeUntil,
          nextAt: Math.min(Date.now() + WRAPPER_PROBE_MS, probeUntil),
        } satisfies Pending);
        continue;
      }
      const attempts = item.attempts + 1;
      // Persist the attempt before sending so eviction cannot reset the retry budget.
      await deps.storage.put(key, {
        ...item,
        attempts,
        nextAt: attempts < MAX_ATTEMPTS ? Date.now() + RETRY_MS : null,
      } satisfies Pending);
      try {
        if (await bounded(deps.closeTerminal(item))) {
          await deps.storage.delete(key);
          continue;
        }
      } catch {
        // Retain the obligation. A transport error does not prove that the PTY closed.
      }
      if (attempts === MAX_ATTEMPTS) deps.reportUnconfirmed(item.ptyId);
    }
  }

  function drain(): Promise<void> {
    if (draining) return draining;
    const promise = performDrain().finally(() => {
      if (draining === promise) draining = undefined;
    });
    draining = promise;
    return promise;
  }

  async function nextAttemptAt(): Promise<number | null> {
    const times = (await pending()).flatMap(item => {
      if (item.attempts === MAX_ATTEMPTS) return [];
      if (item.nextAt !== null) return [item.nextAt];
      if (item.probeUntil !== undefined && item.probeUntil <= Date.now()) return [];
      return [Date.now() + WRAPPER_PROBE_MS];
    });
    return times.length ? Math.min(...times) : null;
  }

  async function hasUnconfirmed(): Promise<boolean> {
    return (await pending()).length > 0;
  }

  return { enqueue, drain, nextAttemptAt, hasUnconfirmed };
}
