import 'server-only';

import {
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
} from '@kilocode/app-shared/organizations';
import {
  organization_default_policy_links,
  organization_group_memberships,
  organization_group_policy_links,
  organization_group_policy_settings,
  organization_groups,
  organization_memberships,
  organization_named_policies,
  organizations,
} from '@kilocode/db/schema';
import {
  isOrganizationFeatureEnabled,
  readOrganizationFeatures,
} from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { db, type DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import {
  bumpOrganizationGroupPolicyRevision,
  lockOrganizationGroupPolicy,
} from '@kilocode/web-shared/lib/organizations/organization-groups';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import * as z from 'zod';
import {
  NAMED_POLICY_EXECUTION_OSES,
  NAMED_POLICY_SCHEMA_VERSION,
  NamedPolicyDocumentSchema,
  NamedPolicyKindSchema,
  type NamedPolicyDocument,
} from './named-policy.schema';
import {
  MAX_MEMBER_PERMISSION_POLICY_BYTES,
  PERMISSION_POLICY_MAX_AGE_SECONDS,
} from './permission-policy.schema';
import { assertOrganizationPermissionPolicyWriteEnabled } from './permission-policy.server';

type StoredPolicy = typeof organization_named_policies.$inferSelect;
type PolicyKind = NamedPolicyDocument['kind'];
type Scope = { type: 'default' } | { type: 'group'; groupId: string };
type Attachment = { policyId: string; scope: Scope };
type AdminAccess = {
  organizationId: string;
  actor: { id: string; isBrowserSession: boolean };
};

const snapshot = { isolationLevel: 'repeatable read', accessMode: 'read only' } as const;
const nameSchema = z.string().trim().min(1).max(80);
const editSchema = z.strictObject({
  name: nameSchema.optional(),
  document: z.unknown().optional(),
});
const clientConfigurationKeys = [
  'disable_auto_approve',
  'disable_telemetry',
  'hide_session_dollar_values',
] as const;

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new TRPCError({ code: 'BAD_REQUEST', message });
  return result.data;
}

async function getMembership(tx: DrizzleTransaction, organizationId: string, userId: string) {
  const [membership] = await tx
    .select({ role: organization_memberships.role, plan: organizations.plan })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId),
        isNull(organizations.deleted_at)
      )
    );
  return membership;
}

async function assertAdmin(
  tx: DrizzleTransaction,
  { organizationId, actor }: AdminAccess,
  write: boolean
) {
  if (!actor.isBrowserSession) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Use a browser session to manage named policies.',
    });
  }
  const membership = await getMembership(tx, organizationId, actor.id);
  const roles = write ? ORGANIZATION_MANAGE_ROLES : ORGANIZATION_BILLING_ROLES;
  if (membership?.plan !== 'enterprise' || !roles.some(role => role === membership.role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Named policy administration is not available.',
    });
  }
}

async function isManaged(tx: DrizzleTransaction, organizationId: string) {
  return isOrganizationFeatureEnabled(
    await readOrganizationFeatures(tx),
    'org_permission_policy',
    organizationId
  );
}

async function getRevision(tx: DrizzleTransaction, organizationId: string) {
  const [settings] = await tx
    .select({ revision: organization_group_policy_settings.policy_revision })
    .from(organization_group_policy_settings)
    .where(eq(organization_group_policy_settings.organization_id, organizationId));
  return settings?.revision ?? 0;
}

async function readAttachments(
  tx: DrizzleTransaction,
  organizationId: string,
  groupIds?: string[]
): Promise<Attachment[]> {
  const defaults = await tx
    .select({ policyId: organization_default_policy_links.policy_id })
    .from(organization_default_policy_links)
    .where(eq(organization_default_policy_links.organization_id, organizationId));
  const groups =
    groupIds?.length === 0
      ? []
      : await tx
          .select({
            policyId: organization_group_policy_links.policy_id,
            groupId: organization_group_policy_links.group_id,
          })
          .from(organization_group_policy_links)
          .where(
            and(
              eq(organization_group_policy_links.organization_id, organizationId),
              groupIds && inArray(organization_group_policy_links.group_id, groupIds)
            )
          )
          .orderBy(asc(organization_group_policy_links.group_id));
  return [
    ...defaults.map(({ policyId }): Attachment => ({ policyId, scope: { type: 'default' } })),
    ...groups.map(({ policyId, groupId }): Attachment => ({
      policyId,
      scope: { type: 'group', groupId },
    })),
  ];
}

function parsedPolicy({ kind, document, schema_version }: StoredPolicy) {
  const parsed = NamedPolicyDocumentSchema.safeParse({ kind, document });
  if (schema_version !== NAMED_POLICY_SCHEMA_VERSION || !parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Stored named policy is invalid.',
    });
  }
  return parsed.data;
}

async function readAttachedPolicies(
  tx: DrizzleTransaction,
  organizationId: string,
  attachments: Attachment[]
) {
  const ids = [...new Set(attachments.map(({ policyId }) => policyId))];
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(organization_named_policies)
    .where(
      and(
        eq(organization_named_policies.organization_id, organizationId),
        inArray(organization_named_policies.id, ids)
      )
    )
    .orderBy(asc(organization_named_policies.id));
  return rows.map(parsedPolicy);
}

function memberPolicy(
  policies: NamedPolicyDocument[],
  os?: (typeof NAMED_POLICY_EXECUTION_OSES)[number]
) {
  const configuration: Partial<Record<(typeof clientConfigurationKeys)[number], true>> = {};
  const layers = policies.flatMap(policy => {
    if (policy.kind === 'client_configuration') {
      for (const key of clientConfigurationKeys) {
        if (policy.document[key]) configuration[key] = true;
      }
      return [];
    }
    const { by_os, ...generic } = policy.document;
    const specific = os && by_os?.[os];
    return [
      { schema_version: NAMED_POLICY_SCHEMA_VERSION, ...generic },
      ...(specific ? [{ schema_version: NAMED_POLICY_SCHEMA_VERSION, ...specific }] : []),
    ];
  });
  return {
    ...(layers.length ? { agent_permissions: { layers } } : {}),
    ...(Object.keys(configuration).length ? { client_configuration: configuration } : {}),
  };
}

function memberPolicyFits(
  organizationId: string,
  revision: number,
  policy: ReturnType<typeof memberPolicy>
) {
  const response = {
    schema_version: NAMED_POLICY_SCHEMA_VERSION,
    organization_id: organizationId,
    managed: true,
    revision,
    max_age_seconds: PERMISSION_POLICY_MAX_AGE_SECONDS,
    policy,
  };
  return Buffer.byteLength(JSON.stringify(response)) <= MAX_MEMBER_PERMISSION_POLICY_BYTES;
}

async function assertAttachedPoliciesFit(tx: DrizzleTransaction, organizationId: string) {
  // The union of all scopes bounds any present or future member's response.
  const attachments = await readAttachments(tx, organizationId);
  const policies = await readAttachedPolicies(tx, organizationId, attachments);
  for (const os of [undefined, ...NAMED_POLICY_EXECUTION_OSES]) {
    if (!memberPolicyFits(organizationId, 2_147_483_647, memberPolicy(policies, os))) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Linked named policies exceed the member policy size limit.',
      });
    }
  }
}

export async function getNamedPolicyMemberSnapshot(params: {
  organizationId: string;
  kiloUserId: string;
  executionOs?: (typeof NAMED_POLICY_EXECUTION_OSES)[number];
}) {
  return await db.transaction(async tx => {
    const { organizationId, kiloUserId } = params;
    const membership = await getMembership(tx, organizationId, kiloUserId);
    if (!membership)
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Direct organization membership is required.',
      });
    const policyRevision = await getRevision(tx, organizationId);
    const managed = membership.plan === 'enterprise' && (await isManaged(tx, organizationId));
    if (!managed) return { managed, policyRevision, policy: {} };
    const groups = await tx
      .select({ id: organization_group_memberships.group_id })
      .from(organization_group_memberships)
      .where(
        and(
          eq(organization_group_memberships.organization_id, organizationId),
          eq(organization_group_memberships.kilo_user_id, kiloUserId)
        )
      );
    const attachments = await readAttachments(
      tx,
      organizationId,
      groups.map(({ id }) => id)
    );
    const policies = await readAttachedPolicies(tx, organizationId, attachments);
    const policy = memberPolicy(policies, params.executionOs);
    if (!memberPolicyFits(organizationId, policyRevision, policy)) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Effective named policy exceeds the size limit.',
      });
    }
    return { managed, policyRevision, policy };
  }, snapshot);
}

export async function listNamedOrganizationPolicies(access: AdminAccess) {
  return await db.transaction(async tx => {
    const { organizationId } = access;
    await assertAdmin(tx, access, false);
    const managed = await isManaged(tx, organizationId);
    const policyRevision = await getRevision(tx, organizationId);
    if (!managed) return { managed, writesEnabled: false, policyRevision, policies: [] };
    const attachments = await readAttachments(tx, organizationId);
    const rows = await tx
      .select()
      .from(organization_named_policies)
      .where(eq(organization_named_policies.organization_id, organizationId))
      .orderBy(asc(organization_named_policies.name), asc(organization_named_policies.id));
    const scopes = new Map<string, Scope[]>();
    for (const { policyId, scope } of attachments) {
      const existing = scopes.get(policyId);
      if (existing) existing.push(scope);
      else scopes.set(policyId, [scope]);
    }
    return {
      managed,
      writesEnabled: process.env.ORG_PERMISSION_POLICY_WRITES_ENABLED === 'true',
      policyRevision,
      policies: rows.map(row => ({
        ...row,
        ...parsedPolicy(row),
        attachments: scopes.get(row.id) ?? [],
      })),
    };
  }, snapshot);
}

async function getPolicy(tx: DrizzleTransaction, organizationId: string, policyId: string) {
  const [row] = await tx
    .select()
    .from(organization_named_policies)
    .where(
      and(
        eq(organization_named_policies.organization_id, organizationId),
        eq(organization_named_policies.id, policyId)
      )
    );
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Named policy not found.' });
  return row;
}

async function assertNameAvailable(
  tx: DrizzleTransaction,
  organizationId: string,
  name: string,
  excludeId?: string
) {
  const [existing] = await tx
    .select({ id: organization_named_policies.id })
    .from(organization_named_policies)
    .where(
      and(
        eq(organization_named_policies.organization_id, organizationId),
        sql`lower(btrim(${organization_named_policies.name})) = lower(${name})`,
        excludeId === undefined ? undefined : ne(organization_named_policies.id, excludeId)
      )
    )
    .limit(1);
  if (existing)
    throw new TRPCError({ code: 'CONFLICT', message: 'A named policy already uses this name.' });
}

async function mutateNamedPolicy<T>(
  access: AdminAccess,
  mutate: (tx: DrizzleTransaction) => Promise<{
    result: T;
    change: string;
  }>
) {
  const { organizationId, actor } = access;
  return await db.transaction(async tx => {
    await lockOrganizationGroupPolicy(tx, organizationId);
    await assertAdmin(tx, access, true);
    await assertOrganizationPermissionPolicyWriteEnabled(organizationId, tx);
    const policyRevision = await bumpOrganizationGroupPolicyRevision(tx, organizationId, actor.id);
    const { result, change } = await mutate(tx);
    await createAuditLog({
      action: 'organization.named_policy.change',
      actor_id: actor.id,
      actor_email: null,
      actor_name: null,
      organization_id: organizationId,
      message: `${change} at revision ${policyRevision}`,
      tx,
    });
    return { result, policyRevision };
  });
}

export async function createNamedOrganizationPolicy(
  access: AdminAccess,
  input: {
    kind: PolicyKind;
    name: string;
    document: unknown;
  }
) {
  return await mutateNamedPolicy(access, async tx => {
    const { organizationId } = access;
    const name = parse(nameSchema, input.name, 'Enter a policy name of 1 to 80 characters.');
    const { kind, document } = parse(
      NamedPolicyDocumentSchema,
      { kind: input.kind, document: input.document },
      'Invalid named policy document.'
    );
    await assertNameAvailable(tx, organizationId, name);
    const [row] = await tx
      .insert(organization_named_policies)
      .values({
        organization_id: organizationId,
        kind,
        name,
        document,
        schema_version: NAMED_POLICY_SCHEMA_VERSION,
      })
      .returning();
    return { result: { ...row, kind, document }, change: `Created ${kind} policy ${row.id}` };
  });
}

export async function updateNamedOrganizationPolicy(
  access: AdminAccess,
  policyId: string,
  input: {
    name?: string;
    document?: unknown;
  }
) {
  return await mutateNamedPolicy(access, async tx => {
    const { organizationId } = access;
    const existing = await getPolicy(tx, organizationId, policyId);
    const { name, document } = parse(editSchema, input, 'Invalid named policy edit.');
    if (name === undefined && document === undefined) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'No named policy changes supplied.' });
    }
    if (name !== undefined) await assertNameAvailable(tx, organizationId, name, policyId);
    if (existing.schema_version !== NAMED_POLICY_SCHEMA_VERSION) {
      throw new TRPCError({ code: 'CONFLICT', message: 'This policy version cannot be edited.' });
    }
    const parsed =
      document === undefined
        ? parsedPolicy(existing)
        : parse(
            NamedPolicyDocumentSchema,
            { kind: existing.kind, document },
            'Invalid named policy document.'
          );
    const [row] = await tx
      .update(organization_named_policies)
      .set({
        name,
        document: parsed.document,
        schema_version: NAMED_POLICY_SCHEMA_VERSION,
      })
      .where(
        and(
          eq(organization_named_policies.organization_id, organizationId),
          eq(organization_named_policies.id, policyId)
        )
      )
      .returning();
    if (document !== undefined) await assertAttachedPoliciesFit(tx, organizationId);
    return { result: { ...row, ...parsed }, change: `Updated ${existing.kind} policy ${policyId}` };
  });
}

export async function deleteNamedOrganizationPolicy(access: AdminAccess, policyId: string) {
  return await mutateNamedPolicy(access, async tx => {
    const { organizationId } = access;
    const policy = await getPolicy(tx, organizationId, policyId);
    const attachments = await readAttachments(tx, organizationId);
    if (attachments.some(attachment => attachment.policyId === policy.id)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Unlink this policy before deleting it.' });
    }
    await tx
      .delete(organization_named_policies)
      .where(
        and(
          eq(organization_named_policies.organization_id, organizationId),
          eq(organization_named_policies.id, policy.id)
        )
      );
    return { result: policy.id, change: `Deleted ${policy.kind} policy ${policy.id}` };
  });
}

export async function setNamedOrganizationPolicyLink(
  access: AdminAccess,
  input: {
    scope: Scope;
    kind: PolicyKind;
    policyId: string | null;
  }
) {
  return await mutateNamedPolicy(access, async tx => {
    const { organizationId } = access;
    const { policyId, scope } = input;
    const kind = parse(NamedPolicyKindSchema, input.kind, 'Invalid named policy kind.');
    const policy = policyId === null ? null : await getPolicy(tx, organizationId, policyId);
    if (policy && policy.kind !== kind) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'The policy does not match this link kind.',
      });
    }
    let previousId: string | undefined;
    let scopeLabel = 'organization default';
    if (scope.type === 'group') {
      const [group] = await tx
        .select({ id: organization_groups.id })
        .from(organization_groups)
        .where(
          and(
            eq(organization_groups.organization_id, organizationId),
            eq(organization_groups.id, scope.groupId)
          )
        );
      if (!group) throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found.' });
      scopeLabel = `group ${group.id}`;
      const [previous] = await tx
        .delete(organization_group_policy_links)
        .where(
          and(
            eq(organization_group_policy_links.organization_id, organizationId),
            eq(organization_group_policy_links.group_id, group.id),
            eq(organization_group_policy_links.kind, kind)
          )
        )
        .returning({ id: organization_group_policy_links.policy_id });
      previousId = previous?.id;
      if (policy)
        await tx.insert(organization_group_policy_links).values({
          organization_id: organizationId,
          group_id: group.id,
          kind,
          policy_id: policy.id,
        });
    } else {
      const [previous] = await tx
        .delete(organization_default_policy_links)
        .where(
          and(
            eq(organization_default_policy_links.organization_id, organizationId),
            eq(organization_default_policy_links.kind, kind)
          )
        )
        .returning({ id: organization_default_policy_links.policy_id });
      previousId = previous?.id;
      if (policy)
        await tx
          .insert(organization_default_policy_links)
          .values({ organization_id: organizationId, kind, policy_id: policy.id });
    }
    if (policy) await assertAttachedPoliciesFit(tx, organizationId);
    return {
      result: policy?.id ?? null,
      change: `Set ${kind} link for ${scopeLabel}: ${previousId ?? 'none'} to ${policy?.id ?? 'none'}`,
    };
  });
}
