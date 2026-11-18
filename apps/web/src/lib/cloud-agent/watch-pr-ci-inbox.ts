import 'server-only';

import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { cloud_agent_pr_watch_activity } from '@kilocode/db/schema';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { watchPrCiInboxRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';
import {
  projectWatchPrEvent,
  watchPrCiEventSchema,
  type WatchPrCiEvent,
  type WatchPrObservationState,
} from './watch-pr-events';

const receiptSchema = z.object({
  deliveryId: z.string().min(1),
  event: watchPrCiEventSchema,
});
const retentionSeconds = 24 * 60 * 60;
const maxReceipts = 100;
const retainReceipt = `
redis.call('ZADD', KEYS[1], 'NX', ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, -tonumber(ARGV[4]) - 1)
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 1
`;

export async function retainWatchPrCiEvent(input: {
  event: WatchPrCiEvent;
  deliveryId: string;
  appType: GitHubAppType;
}) {
  const now = Date.now();
  const receipt = receiptSchema.parse({ deliveryId: input.deliveryId, event: input.event });
  await redisClient.eval(
    retainReceipt,
    [watchPrCiInboxRedisKey({ ...input.event, appType: input.appType })],
    [now, JSON.stringify(receipt), now - retentionSeconds * 1000, maxReceipts, retentionSeconds]
  );
}

export async function readWatchPrCiEvents(input: {
  installationId: string;
  repositoryId: string;
  appType: GitHubAppType;
  headSha: string;
  createdAt: string;
}) {
  const receipts = await redisClient.zrange<string[]>(
    watchPrCiInboxRedisKey(input),
    Math.max(Date.parse(input.createdAt), Date.now() - retentionSeconds * 1000),
    '+inf',
    { byScore: true, offset: 0, count: maxReceipts }
  );
  const validReceipts: z.infer<typeof receiptSchema>[] = [];
  for (const receipt of receipts) {
    try {
      const parsed = receiptSchema.safeParse(JSON.parse(receipt));
      if (parsed.success) validReceipts.push(parsed.data);
    } catch {
      continue;
    }
  }
  return validReceipts.filter(
    receipt =>
      receipt.event.installationId === input.installationId &&
      receipt.event.repositoryId === input.repositoryId &&
      receipt.event.sha === input.headSha
  );
}

export async function replayWatchPrCiEvents(
  tx: DrizzleTransaction,
  watch: { id: string; created_at: string; installation_id: string; repository_id: string },
  next: WatchPrObservationState,
  appType: GitHubAppType
) {
  const receipts = await readWatchPrCiEvents({
    installationId: watch.installation_id,
    repositoryId: watch.repository_id,
    appType,
    headSha: next.head_sha,
    createdAt: new Date(watch.created_at).toISOString(),
  });
  if (!receipts.length) return next;
  const existing = await tx
    .select({ deliveryId: cloud_agent_pr_watch_activity.delivery_id })
    .from(cloud_agent_pr_watch_activity)
    .where(
      and(
        eq(cloud_agent_pr_watch_activity.watch_id, watch.id),
        inArray(
          cloud_agent_pr_watch_activity.delivery_id,
          receipts.map(receipt => receipt.deliveryId)
        )
      )
    );
  const seen = new Set(existing.map(receipt => receipt.deliveryId));
  const activity: (typeof cloud_agent_pr_watch_activity.$inferInsert)[] = [];
  for (const receipt of receipts) {
    if (seen.has(receipt.deliveryId)) continue;
    seen.add(receipt.deliveryId);
    const projected = projectWatchPrEvent(next, receipt.event, next.generation);
    activity.push({
      watch_id: watch.id,
      generation: next.generation,
      delivery_id: receipt.deliveryId,
      kind: 'observation',
      reason: projected === next ? 'unchanged' : 'projected',
      data: receipt.event,
    });
    next = projected;
  }
  if (activity.length) await tx.insert(cloud_agent_pr_watch_activity).values(activity);
  return next;
}
