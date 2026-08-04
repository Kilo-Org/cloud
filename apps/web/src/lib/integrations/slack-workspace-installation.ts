import 'server-only';
import { db } from '@/lib/drizzle';
import {
  platform_integrations,
  slack_workspace_installations,
  type PlatformIntegration,
  type SlackWorkspaceInstallation,
} from '@kilocode/db/schema';
import { and, eq, isNotNull } from 'drizzle-orm';
import { PLATFORM } from '@/lib/integrations/core/constants';

/**
 * Workspace-level Slack installation state.
 *
 * Slack issues exactly one installation per (app, workspace), so the bot token
 * belongs to the workspace rather than to any single Kilo owner. This module owns
 * reads and writes for that record; `slack-service` owns the per-owner
 * `platform_integrations` row.
 */

/**
 * Resolve the Slack team ID a platform integration points at.
 *
 * Rows detached by the 0108 duplicate-workspace migration have a NULL
 * `platform_installation_id` but retain `platform_account_id`, so both are
 * checked. Callers that need to mutate shared workspace state should prefer
 * `platform_installation_id` only.
 */
export function getSlackTeamIdFromInstallation(
  integration: PlatformIntegration
): string | undefined {
  return integration.platform_installation_id ?? integration.platform_account_id ?? undefined;
}

export async function getSlackWorkspaceInstallation(
  teamId: string
): Promise<SlackWorkspaceInstallation | null> {
  const [installation] = await db
    .select()
    .from(slack_workspace_installations)
    .where(eq(slack_workspace_installations.team_id, teamId))
    .limit(1);

  return installation ?? null;
}

/**
 * Create or refresh the workspace record. Called on every completed Slack OAuth
 * install so the stored token always matches the most recent installation.
 */
export async function upsertSlackWorkspaceInstallation({
  teamId,
  teamName,
  botToken,
  botUserId,
  scopes,
  installedByUserId,
}: {
  teamId: string;
  teamName?: string | null;
  botToken: string;
  botUserId?: string | null;
  scopes?: string[] | null;
  installedByUserId?: string | null;
}): Promise<SlackWorkspaceInstallation> {
  const now = new Date().toISOString();

  const [installation] = await db
    .insert(slack_workspace_installations)
    .values({
      team_id: teamId,
      team_name: teamName ?? null,
      bot_token: botToken,
      bot_user_id: botUserId ?? null,
      scopes: scopes ?? null,
      last_installed_by_user_id: installedByUserId ?? null,
      installed_at: now,
    })
    .onConflictDoUpdate({
      target: slack_workspace_installations.team_id,
      set: {
        team_name: teamName ?? null,
        bot_token: botToken,
        bot_user_id: botUserId ?? null,
        scopes: scopes ?? null,
        last_installed_by_user_id: installedByUserId ?? null,
        installed_at: now,
        updated_at: now,
      },
    })
    .returning();

  return installation;
}

export async function deleteSlackWorkspaceInstallation(teamId: string): Promise<void> {
  await db
    .delete(slack_workspace_installations)
    .where(eq(slack_workspace_installations.team_id, teamId));
}

/**
 * Number of platform integrations still connected to a Slack workspace.
 *
 * Used to decide whether workspace-wide teardown (token revocation, Chat SDK
 * state, this table) is safe. Only rows with a non-NULL
 * `platform_installation_id` count: detached 0108 rows no longer hold a claim on
 * the workspace.
 */
export async function countSlackConnections(teamId: string): Promise<number> {
  const connections = await db
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.platform, PLATFORM.SLACK),
        eq(platform_integrations.platform_installation_id, teamId),
        isNotNull(platform_integrations.platform_installation_id)
      )
    );

  return connections.length;
}

/**
 * Resolve the bot token for an integration.
 *
 * `platform_integrations.metadata.access_token` is preferred while it still
 * exists, with the workspace record as the fallback.
 *
 * That order looks backwards for a table introduced as the workspace-level store,
 * but it is the only safe one until the previous release is fully rolled out.
 * Every writer updates `metadata` — the previous release writes only there, and
 * this release mirrors into it — so `metadata` is never staler than the workspace
 * record. The reverse is not true: a disconnect and reconnect served by the
 * previous release deletes and recreates `platform_integrations` without touching
 * the workspace record, which would leave a revoked token here outranking the
 * fresh one in `metadata`.
 *
 * The follow-up that removes the mirror also removes this preference, leaving the
 * workspace record as the only source. Doing it in that order is what makes the
 * rollout safe in both directions.
 */
export async function getSlackBotToken(
  integration: PlatformIntegration
): Promise<string | undefined> {
  const metadata = integration.metadata as { access_token?: string } | null;
  if (metadata?.access_token) {
    return metadata.access_token;
  }

  const teamId = getSlackTeamIdFromInstallation(integration);
  if (!teamId) {
    return undefined;
  }

  const workspaceInstallation = await getSlackWorkspaceInstallation(teamId);
  return workspaceInstallation?.bot_token ?? undefined;
}
