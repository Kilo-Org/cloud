import { kilocode_users, type WorkerDb } from '@kilocode/db';
import { withTimeout } from '@kilocode/worker-utils';
import { and, inArray, isNotNull, or } from 'drizzle-orm';
import {
  ContainerAccountBlockedError,
  ContainerCapacityUnavailableError,
} from './container-concurrency.js';
import { getPgDb } from './db/pg.js';
import type { SandboxBillingInput } from './container-usage-context.js';
import type { Env } from './types.js';

type AccountIdentity = Pick<SandboxBillingInput, 'subject' | 'actor'>;

/** Capacity exemptions do not exempt an acting user or a personal payer from account blocks. */
export async function readContainerAccountBlocked(
  db: WorkerDb,
  input: AccountIdentity
): Promise<boolean> {
  const users = new Set<string>();
  if (input.actor.type === 'user') users.add(input.actor.id);
  if (input.subject.type === 'user') users.add(input.subject.id);
  if (users.size === 0) return false;
  const [blocked] = await db
    .select({ id: kilocode_users.id })
    .from(kilocode_users)
    .where(
      and(
        inArray(kilocode_users.id, [...users]),
        or(isNotNull(kilocode_users.blocked_at), isNotNull(kilocode_users.blocked_reason))
      )
    )
    .limit(1);
  return blocked !== undefined;
}

/** Retain main's bounded account admission independently of atomic meter capacity. */
export async function assertContainerAccountAvailable(
  env: Pick<Env, 'HYPERDRIVE' | 'CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED'>,
  input: AccountIdentity
): Promise<void> {
  if (env.CLOUD_AGENT_CONTAINER_CONCURRENCY_DISABLED === 'true') return;
  if (input.actor.type === 'bot' && input.subject.type === 'org') return;
  let blocked: boolean;
  try {
    const read = () => readContainerAccountBlocked(getPgDb(env), input);
    blocked = await withTimeout(
      (async () => {
        try {
          return await read();
        } catch {
          await new Promise(resolve => setTimeout(resolve, 250));
          return read();
        }
      })(),
      10_000,
      'Container account admission timed out'
    );
  } catch {
    throw new ContainerCapacityUnavailableError();
  }
  if (blocked) throw new ContainerAccountBlockedError();
}
