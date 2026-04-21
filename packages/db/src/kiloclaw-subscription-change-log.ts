import {
  kiloclaw_subscription_change_log,
  type KiloClawSubscription,
  type NewKiloClawSubscriptionChangeLog,
} from './schema';
import type {
  KiloClawSubscriptionChangeAction,
  KiloClawSubscriptionChangeActorType,
} from './schema-types';

type SubscriptionChangeLogWriter = {
  insert: (table: typeof kiloclaw_subscription_change_log) => {
    values: (value: NewKiloClawSubscriptionChangeLog) => PromiseLike<unknown>;
  };
};

export type KiloClawSubscriptionChangeActor =
  | {
      actorType: Extract<KiloClawSubscriptionChangeActorType, 'user'>;
      actorId: string;
    }
  | {
      actorType: Extract<KiloClawSubscriptionChangeActorType, 'system'>;
      actorId: string;
    };

export type KiloClawSubscriptionChangeLogInput = {
  subscriptionId: string;
  action: KiloClawSubscriptionChangeAction;
  actor: KiloClawSubscriptionChangeActor;
  reason?: string | null;
  before: KiloClawSubscription | null;
  after: KiloClawSubscription | null;
};

export function serializeKiloClawSubscriptionSnapshot(
  subscription: KiloClawSubscription | null
): Record<string, unknown> | null {
  if (!subscription) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(subscription).map(([key, value]) => [key, value ?? null])
  );
}

export async function insertKiloClawSubscriptionChangeLog<
  TWriter extends SubscriptionChangeLogWriter,
>(writer: TWriter, input: KiloClawSubscriptionChangeLogInput): Promise<void> {
  await writer.insert(kiloclaw_subscription_change_log).values({
    subscription_id: input.subscriptionId,
    actor_type: input.actor.actorType,
    actor_id: input.actor.actorId,
    action: input.action,
    reason: input.reason ?? null,
    before_state: serializeKiloClawSubscriptionSnapshot(input.before),
    after_state: serializeKiloClawSubscriptionSnapshot(input.after),
  });
}
