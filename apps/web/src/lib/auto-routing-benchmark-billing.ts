import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { estimateMicrodollars } from '@kilocode/auto-routing-contracts';
import {
  auto_routing_benchmark_holds,
  credit_transactions,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { toMicrodollars } from '@kilocode/web-shared/lib/microdollars';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@kilocode/web-shared/lib/kilo-pass/usage-triggered-bonus';

const ownerSchema = z
  .object({
    admissionId: z.string().min(1).max(200),
    ownerType: z.enum(['user', 'org']),
    ownerId: z.string().min(1).max(200),
  })
  .refine(input => input.ownerType !== 'org' || z.uuid().safeParse(input.ownerId).success, {
    path: ['ownerId'],
    message: 'Organization owner IDs must be UUIDs',
  });
const pairSchema = z.object({
  model: z.string().min(1).max(300),
  variant: z.string().min(1).max(100).nullable(),
});
const costSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 1_000_000)
  .refine(
    value => Number.isSafeInteger(estimateMicrodollars(value)),
    'Cost exceeds safe credit precision'
  );

export const benchmarkReserveSchema = ownerSchema
  .safeExtend({
    items: z
      .array(pairSchema.extend({ estimatedCostUsd: costSchema }))
      .min(1)
      .max(1000),
  })
  .superRefine((input, ctx) => {
    const keys = input.items.map(pairKey);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['items'], message: 'Duplicate benchmark pairs' });
    }
    if (
      !Number.isSafeInteger(
        input.items.reduce((sum, item) => sum + estimateMicrodollars(item.estimatedCostUsd), 0)
      )
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['items'],
        message: 'Total estimate exceeds safe credit precision',
      });
    }
  });
export const benchmarkSettleSchema = ownerSchema
  .safeExtend(pairSchema.shape)
  .safeExtend({
    runId: z.string().min(1).max(200).nullable(),
    actualCostUsd: costSchema,
  })
  .refine(input => input.runId !== null || input.actualCostUsd === 0, {
    path: ['runId'],
    message: 'A charged benchmark must have a run ID',
  });

type OwnerInput = z.infer<typeof ownerSchema>;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Hold = typeof auto_routing_benchmark_holds.$inferSelect;

export class BenchmarkBillingError extends Error {
  constructor(
    readonly status: 402 | 403 | 404 | 409,
    readonly code:
      | 'insufficient_credits'
      | 'owner_blocked'
      | 'owner_not_found'
      | 'hold_not_found'
      | 'idempotency_conflict',
    readonly details?: { availableCostUsd: number; requiredCostUsd: number }
  ) {
    super(code);
  }
}

function pairKey(pair: { model: string; variant: string | null }) {
  return JSON.stringify([pair.model, pair.variant]);
}

function holdWhere(input: OwnerInput) {
  return and(
    eq(auto_routing_benchmark_holds.owner_type, input.ownerType),
    eq(auto_routing_benchmark_holds.owner_id, input.ownerId),
    eq(auto_routing_benchmark_holds.admission_id, input.admissionId)
  );
}

async function lockOwner(tx: Transaction, input: OwnerInput, reserving: boolean) {
  if (input.ownerType === 'user') {
    const [owner] = await tx
      .select({
        acquired: kilocode_users.total_microdollars_acquired,
        used: kilocode_users.microdollars_used,
        kiloPassThreshold: kilocode_users.kilo_pass_threshold,
        blockedAt: kilocode_users.blocked_at,
        blockedReason: kilocode_users.blocked_reason,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, input.ownerId))
      .for('update');
    if (!owner) throw new BenchmarkBillingError(404, 'owner_not_found');
    if (reserving && (owner.blockedAt !== null || owner.blockedReason !== null)) {
      throw new BenchmarkBillingError(403, 'owner_blocked');
    }
    return owner;
  }
  const [owner] = await tx
    .select({
      acquired: organizations.total_microdollars_acquired,
      used: organizations.microdollars_used,
      deletedAt: organizations.deleted_at,
    })
    .from(organizations)
    .where(eq(organizations.id, input.ownerId))
    .for('update');
  if (!owner) throw new BenchmarkBillingError(404, 'owner_not_found');
  if (reserving && owner.deletedAt !== null) throw new BenchmarkBillingError(403, 'owner_blocked');
  return owner;
}

async function updateOwnerCredits(
  tx: Transaction,
  input: OwnerInput,
  acquiredDelta: number,
  usageDelta: number
) {
  if (input.ownerType === 'user') {
    await tx
      .update(kilocode_users)
      .set({
        total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${acquiredDelta}`,
        microdollars_used: sql`${kilocode_users.microdollars_used} + ${usageDelta}`,
      })
      .where(eq(kilocode_users.id, input.ownerId));
  } else {
    await tx
      .update(organizations)
      .set({
        total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${acquiredDelta}`,
        microdollars_used: sql`${organizations.microdollars_used} + ${usageDelta}`,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${acquiredDelta - usageDelta}`,
      })
      .where(eq(organizations.id, input.ownerId));
  }
}

function ledgerEntry(
  input: OwnerInput,
  pair: { model: string; variant: string | null },
  phase: 'hold' | 'settle',
  amount: number,
  baseline: number
) {
  const identity = createHash('sha256')
    .update(
      JSON.stringify([input.ownerType, input.ownerId, input.admissionId, pair.model, pair.variant])
    )
    .digest('hex');
  return {
    id: randomUUID(),
    kilo_user_id: input.ownerType === 'user' ? input.ownerId : 'system:auto-routing-benchmark',
    organization_id: input.ownerType === 'org' ? input.ownerId : null,
    amount_microdollars: amount,
    is_free: true,
    description: `Auto routing benchmark ${phase}: ${pair.model}${pair.variant === null ? '' : ` (${pair.variant})`}`,
    credit_category: `auto-routing-benchmark:${identity}:${phase}`,
    check_category_uniqueness: true,
    original_baseline_microdollars_used: baseline,
  };
}

function reserveResponse(input: z.infer<typeof benchmarkReserveSchema>, holds: Hold[]) {
  const byPair = new Map(holds.map(hold => [hold.pair_key, hold]));
  return {
    admissionId: input.admissionId,
    heldCostUsd:
      holds.reduce(
        (sum, hold) => sum + (hold.charged_microdollars === null ? hold.estimated_microdollars : 0),
        0
      ) / 1_000_000,
    items: input.items.map(item => {
      const hold = byPair.get(pairKey(item));
      if (!hold) throw new Error('Missing reserved benchmark pair');
      return {
        model: hold.model,
        variant: hold.variant,
        estimatedCostUsd: hold.estimated_microdollars / 1_000_000,
        status: hold.charged_microdollars === null ? ('held' as const) : ('settled' as const),
        chargedCostUsd:
          hold.charged_microdollars === null ? null : hold.charged_microdollars / 1_000_000,
      };
    }),
  };
}

export async function reserveBenchmarkCredits(rawInput: unknown) {
  const input = benchmarkReserveSchema.parse(rawInput);
  return db.transaction(async tx => {
    const owner = await lockOwner(tx, input, true);
    const existing = await tx.select().from(auto_routing_benchmark_holds).where(holdWhere(input));
    if (existing.length > 0) {
      const requested = new Map(
        input.items.map(item => [pairKey(item), estimateMicrodollars(item.estimatedCostUsd)])
      );
      if (
        existing.length !== requested.size ||
        existing.some(hold => requested.get(hold.pair_key) !== hold.estimated_microdollars)
      ) {
        throw new BenchmarkBillingError(409, 'idempotency_conflict');
      }
      return reserveResponse(input, existing);
    }
    const required = input.items.reduce(
      (sum, item) => sum + estimateMicrodollars(item.estimatedCostUsd),
      0
    );
    const available = owner.acquired - owner.used;
    if (available < required) {
      throw new BenchmarkBillingError(402, 'insufficient_credits', {
        availableCostUsd: available / 1_000_000,
        requiredCostUsd: required / 1_000_000,
      });
    }
    const ledger = input.items.map(item =>
      ledgerEntry(input, item, 'hold', -estimateMicrodollars(item.estimatedCostUsd), owner.used)
    );
    await tx.insert(credit_transactions).values(ledger);
    const holds = await tx
      .insert(auto_routing_benchmark_holds)
      .values(
        input.items.map((item, index) => {
          const credit = ledger[index];
          if (!credit) throw new Error('Missing benchmark hold ledger entry');
          return {
            admission_id: input.admissionId,
            owner_type: input.ownerType,
            owner_id: input.ownerId,
            pair_key: pairKey(item),
            model: item.model,
            variant: item.variant,
            estimated_microdollars: estimateMicrodollars(item.estimatedCostUsd),
            hold_credit_transaction_id: credit.id,
          };
        })
      )
      .returning();
    await updateOwnerCredits(tx, input, -required, 0);
    return reserveResponse(input, holds);
  });
}

export async function settleBenchmarkCredits(rawInput: unknown) {
  const input = benchmarkSettleSchema.parse(rawInput);
  const charged = toMicrodollars(input.actualCostUsd);
  let shouldIssueUsageBonus = false;
  const result = await db.transaction(async tx => {
    const owner = await lockOwner(tx, input, false);
    const predicate = and(
      holdWhere(input),
      eq(auto_routing_benchmark_holds.pair_key, pairKey(input))
    );
    const [hold] = await tx.select().from(auto_routing_benchmark_holds).where(predicate);
    if (!hold) throw new BenchmarkBillingError(404, 'hold_not_found');
    shouldIssueUsageBonus =
      charged > 0 && 'kiloPassThreshold' in owner && owner.kiloPassThreshold !== null;
    if (hold.charged_microdollars !== null) {
      if (hold.charged_microdollars !== charged || hold.run_id !== input.runId) {
        throw new BenchmarkBillingError(409, 'idempotency_conflict');
      }
    } else {
      const ledger = ledgerEntry(input, input, 'settle', hold.estimated_microdollars, owner.used);
      await tx.insert(credit_transactions).values(ledger);
      await updateOwnerCredits(tx, input, hold.estimated_microdollars, charged);
      await tx
        .update(auto_routing_benchmark_holds)
        .set({
          charged_microdollars: charged,
          run_id: input.runId,
          settlement_credit_transaction_id: ledger.id,
          settled_at: new Date().toISOString(),
        })
        .where(predicate);
    }
    return {
      admissionId: input.admissionId,
      model: input.model,
      variant: input.variant,
      runId: input.runId,
      chargedCostUsd: charged / 1_000_000,
      releasedCostUsd: Math.max(0, hold.estimated_microdollars - charged) / 1_000_000,
    };
  });
  if (shouldIssueUsageBonus) {
    await maybeIssueKiloPassBonusFromUsageThreshold({
      kiloUserId: input.ownerId,
      nowIso: new Date().toISOString(),
    });
  }
  return result;
}
