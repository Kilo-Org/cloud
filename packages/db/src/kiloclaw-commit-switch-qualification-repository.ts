import { sql } from 'drizzle-orm';

import type { WorkerDb } from './client';
import {
  KILOCLAW_COMMIT_SALES_CUTOFF,
  KiloClawCommitRetirementQualificationSource,
} from './kiloclaw-commit-retirement';
import { kiloclaw_subscription_change_log, kiloclaw_subscriptions } from './schema';
import {
  KiloClawSubscriptionChangeAction,
  KiloClawSubscriptionChangeActorType,
} from './schema-types';

export type CommitSwitchQualificationRepository = Pick<WorkerDb, 'execute'>;

export type KiloClawCommitSwitchQualification = {
  qualifiedAt: string;
  qualificationSource: Extract<
    KiloClawCommitRetirementQualificationSource,
    'switch_requested_before_cutoff'
  >;
};

export async function findLatestPreCutoffUserCommitSwitchQualification(
  database: CommitSwitchQualificationRepository,
  subscriptionId: string,
  cutoff: string = KILOCLAW_COMMIT_SALES_CUTOFF
): Promise<KiloClawCommitSwitchQualification | null> {
  const { rows } = await database.execute<{ created_at: string }>(sql`
    WITH RECURSIVE subscription_lineage AS (
      SELECT ${kiloclaw_subscriptions.id}
      FROM ${kiloclaw_subscriptions}
      WHERE ${kiloclaw_subscriptions.id} = ${subscriptionId}
      UNION
      SELECT predecessor.${sql.identifier(kiloclaw_subscriptions.id.name)}
      FROM ${kiloclaw_subscriptions} predecessor
      INNER JOIN subscription_lineage successor
        ON predecessor.${sql.identifier(kiloclaw_subscriptions.transferred_to_subscription_id.name)} = successor.${sql.identifier(kiloclaw_subscriptions.id.name)}
    )
    SELECT change.${sql.identifier(kiloclaw_subscription_change_log.created_at.name)} AS created_at
    FROM ${kiloclaw_subscription_change_log} change
    INNER JOIN subscription_lineage lineage
      ON change.${sql.identifier(kiloclaw_subscription_change_log.subscription_id.name)} = lineage.${sql.identifier(kiloclaw_subscriptions.id.name)}
    WHERE change.${sql.identifier(kiloclaw_subscription_change_log.action.name)} = ${KiloClawSubscriptionChangeAction.ScheduleChanged}
      AND change.${sql.identifier(kiloclaw_subscription_change_log.actor_type.name)} = ${KiloClawSubscriptionChangeActorType.User}
      AND change.${sql.identifier(kiloclaw_subscription_change_log.created_at.name)} < ${cutoff}
      AND change.${sql.identifier(kiloclaw_subscription_change_log.after_state.name)}->>'scheduled_plan' = 'commit'
      AND COALESCE(change.${sql.identifier(kiloclaw_subscription_change_log.before_state.name)}->>'scheduled_plan', '') <> 'commit'
    ORDER BY
      change.${sql.identifier(kiloclaw_subscription_change_log.created_at.name)} DESC,
      change.${sql.identifier(kiloclaw_subscription_change_log.id.name)} DESC
    LIMIT 1
  `);
  const change = rows[0];
  if (!change) return null;

  return {
    qualifiedAt: new Date(change.created_at).toISOString(),
    qualificationSource: KiloClawCommitRetirementQualificationSource.SwitchRequestedBeforeCutoff,
  };
}
