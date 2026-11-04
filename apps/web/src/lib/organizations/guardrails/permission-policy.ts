import { createHash } from 'node:crypto';
import {
  organization_permission_events_daily,
  organization_permission_rules,
  type Organization,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { eq, sql } from 'drizzle-orm';
import {
  comparePermissionRules,
  PERMISSION_MATCH_ALGORITHM,
  PERMISSION_TIERS,
  tierAction,
  type PermissionAction,
  type PermissionEnforcement,
  type PermissionEventDecision,
  type PermissionPolicyResponse,
  type PermissionTier,
} from '@/lib/organizations/permissions/types';
import { resolvePermissionSettings } from './guardrails-policy';
import type { McpConnectClient } from './mcp-connections';

type PolicyOrganization = Pick<Organization, 'id' | 'settings'>;

type RevisionInputs = {
  enforcement: PermissionEnforcement;
  defaultEffect: PermissionAction;
  rules: readonly RuleVersion[];
};

type RuleVersion = { id: string; updated_at: string };

export type PermissionPolicyVersion = { revision: number; etag: string };

function policyVersion(inputs: RevisionInputs): PermissionPolicyVersion {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        inputs.enforcement,
        inputs.defaultEffect,
        inputs.rules
          .map(rule => [rule.id, rule.updated_at])
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ])
    )
    .digest();
  return {
    revision: digest.readUInt32BE(0) & 0x7fffffff,
    etag: `"${digest.subarray(0, 16).toString('hex')}"`,
  };
}

const OFF_INPUTS: RevisionInputs = {
  enforcement: 'off',
  defaultEffect: 'allow',
  rules: [],
};

function loadRuleVersions(organizationId: string): Promise<RuleVersion[]> {
  return db
    .select({
      id: organization_permission_rules.id,
      updated_at: organization_permission_rules.updated_at,
    })
    .from(organization_permission_rules)
    .where(eq(organization_permission_rules.organization_id, organizationId));
}

/** The policy's revision and ETag, fingerprinting each rule's id and update time with the settings. */
export async function getPermissionPolicyVersion(
  organization: PolicyOrganization
): Promise<PermissionPolicyVersion & { enforcement: PermissionEnforcement }> {
  const settings = resolvePermissionSettings(organization);
  if (settings.enforcement === 'off') {
    return { ...policyVersion(OFF_INPUTS), enforcement: 'off' };
  }
  return {
    ...policyVersion({ ...settings, rules: await loadRuleVersions(organization.id) }),
    enforcement: settings.enforcement,
  };
}

/**
 * The ordered policy for clients. While enforcement is off or AI Guardrails is not granted, the
 * policy has no rules and allows by default.
 */
export async function getPermissionPolicy(
  organization: PolicyOrganization
): Promise<{ policy: PermissionPolicyResponse; etag: string }> {
  const settings = resolvePermissionSettings(organization);
  const evaluation = {
    tiers: [...PERMISSION_TIERS],
    match: PERMISSION_MATCH_ALGORITHM as typeof PERMISSION_MATCH_ALGORITHM,
  };
  if (settings.enforcement === 'off') {
    const { revision, etag } = policyVersion(OFF_INPUTS);
    return {
      policy: {
        schemaVersion: 1,
        revision,
        enforcement: 'off',
        defaultEffect: 'allow',
        evaluation,
        rules: [],
      },
      etag,
    };
  }

  const rows = await db
    .select()
    .from(organization_permission_rules)
    .where(eq(organization_permission_rules.organization_id, organization.id));
  const { revision, etag } = policyVersion({ ...settings, rules: rows });
  return {
    policy: {
      schemaVersion: 1,
      revision,
      enforcement: settings.enforcement,
      defaultEffect: settings.defaultEffect,
      evaluation,
      rules: rows.sort(comparePermissionRules).map(row => ({
        id: row.id,
        tier: row.tier,
        permission: row.permission,
        pattern: row.pattern,
        action: tierAction(row.tier),
        scope: { type: 'organization' as const },
        description: row.description,
      })),
    },
    etag,
  };
}

/** RFC 9110 weak comparison: any listed tag, ignoring `W/`, or `*`, matches. */
export function ifNoneMatchMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  const opaque = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map(tag => tag.trim())
    .some(tag => tag === '*' || tag.replace(/^W\//, '') === opaque);
}

export type PermissionEventEntry = {
  day: string;
  permission: string;
  commandKey: string;
  decision: PermissionEventDecision;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  ruleId?: string;
  tier?: PermissionTier;
};

const MAX_INT32 = 2147483647;

function mergeEntries(entries: readonly PermissionEventEntry[]): PermissionEventEntry[] {
  const merged = new Map<string, PermissionEventEntry>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.day, entry.permission, entry.commandKey, entry.decision]);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...entry });
      continue;
    }
    const newer = Date.parse(entry.lastSeenAt) >= Date.parse(existing.lastSeenAt);
    merged.set(key, {
      ...existing,
      count: Math.min(existing.count + entry.count, MAX_INT32),
      firstSeenAt:
        Date.parse(entry.firstSeenAt) < Date.parse(existing.firstSeenAt)
          ? entry.firstSeenAt
          : existing.firstSeenAt,
      lastSeenAt: newer ? entry.lastSeenAt : existing.lastSeenAt,
      ruleId: newer ? entry.ruleId : existing.ruleId,
      tier: newer ? entry.tier : existing.tier,
    });
  }
  return [...merged.values()];
}

/**
 * Adds client-aggregated org decisions to the daily rollup in one upsert. Records nothing while
 * enforcement is off or AI Guardrails is not granted. Returns the current revision so a stale
 * client refetches the policy.
 */
export async function recordPermissionEvents(params: {
  organization: PolicyOrganization;
  kiloUserId: string;
  client: McpConnectClient;
  policyRevision?: number;
  entries: readonly PermissionEventEntry[];
}): Promise<{ revision: number }> {
  const { organization, kiloUserId, client, policyRevision, entries } = params;
  const { revision, enforcement } = await getPermissionPolicyVersion(organization);
  if (enforcement === 'off' || entries.length === 0) return { revision };

  const table = organization_permission_events_daily;
  const newer = sql`excluded.last_seen_at >= ${table.last_seen_at}`;
  await db
    .insert(table)
    .values(
      mergeEntries(entries).map(entry => ({
        organization_id: organization.id,
        day: entry.day,
        kilo_user_id: kiloUserId,
        client,
        permission: entry.permission,
        command_key: entry.commandKey,
        decision: entry.decision,
        count: entry.count,
        first_seen_at: entry.firstSeenAt,
        last_seen_at: entry.lastSeenAt,
        last_rule_id: entry.ruleId ?? null,
        last_tier: entry.tier ?? null,
        last_policy_revision: policyRevision ?? null,
      }))
    )
    .onConflictDoUpdate({
      target: [
        table.organization_id,
        table.day,
        table.kilo_user_id,
        table.client,
        table.permission,
        table.command_key,
        table.decision,
      ],
      set: {
        count: sql`least(${table.count}::bigint + excluded.count, ${MAX_INT32})::int`,
        first_seen_at: sql`least(${table.first_seen_at}, excluded.first_seen_at)`,
        last_seen_at: sql`greatest(${table.last_seen_at}, excluded.last_seen_at)`,
        last_rule_id: sql`CASE WHEN ${newer} THEN excluded.last_rule_id ELSE ${table.last_rule_id} END`,
        last_tier: sql`CASE WHEN ${newer} THEN excluded.last_tier ELSE ${table.last_tier} END`,
        last_policy_revision: sql`CASE WHEN ${newer} THEN excluded.last_policy_revision ELSE ${table.last_policy_revision} END`,
      },
    });
  return { revision };
}
