import 'server-only';

import {
  CustomRouterPoolPinsRequestSchema,
  CustomRouterPoolPinsResponseSchema,
  type CustomRouterPoolPinsRequest,
  type CustomRouterPoolPinsResponse,
} from '@kilocode/auto-routing-contracts';
import { auto_routing_custom_routers } from '@kilocode/db/schema';
import {
  customRouterOwnerCondition,
  toCustomRouterDefinition,
  type CustomRouterOwner,
} from '@kilocode/web-shared/lib/ai-gateway/custom-routers';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq } from 'drizzle-orm';
import { customRouterPoolVersion, lockOwner } from '@/lib/auto-routing-custom-routers';
import { decideServingPins } from '@/lib/auto-routing-pool-pin-decision';

export class PoolPinsRouterNotFoundError extends Error {
  constructor() {
    super('Custom router not found');
    this.name = 'PoolPinsRouterNotFoundError';
  }
}

/**
 * Applies the benchmark worker's settlement callback to one saved pool. The decision is pure
 * (`decideServingPins`); this only reads the locked row and writes the result.
 *
 * Writing a pin leaves `updated_at` untouched, because `customRouterPoolVersion` includes it: a
 * pin-only write must not invalidate an outstanding quote.
 */
export async function applyServingPins(
  input: CustomRouterPoolPinsRequest
): Promise<CustomRouterPoolPinsResponse> {
  const request = CustomRouterPoolPinsRequestSchema.parse(input);
  const owner: CustomRouterOwner = { type: request.ownerType, id: request.ownerId };
  const now = new Date().toISOString();

  return db.transaction(async tx => {
    await lockOwner(tx, owner);
    const [row] = await tx
      .select()
      .from(auto_routing_custom_routers)
      .where(
        and(eq(auto_routing_custom_routers.id, request.routerId), customRouterOwnerCondition(owner))
      )
      .limit(1);
    if (!row) throw new PoolPinsRouterNotFoundError();

    const router = toCustomRouterDefinition(row);
    const poolUnchanged = customRouterPoolVersion(router, row.updated_at) === request.poolVersion;
    const { entries, applied, skipped } = decideServingPins({
      entries: router.entries,
      aliases: request.aliases,
      poolUnchanged,
      requestId: request.requestId,
      confirmedAt: request.confirmedAt,
      pinnedAt: now,
    });

    if (applied.length > 0) {
      await tx
        .update(auto_routing_custom_routers)
        .set({ entries, updated_at: row.updated_at })
        .where(eq(auto_routing_custom_routers.id, request.routerId));
    }

    return CustomRouterPoolPinsResponseSchema.parse({
      routerId: request.routerId,
      poolUnchanged,
      applied,
      skipped,
    });
  });
}
