import * as z from 'zod';

import { ORGANIZATION_ROLES, type OrganizationRole } from './roles';

/**
 * The structured payload an organization audit row carries beside its English
 * `message`.
 *
 * The mobile app renders the row's detail line from this payload in the
 * reader's language; `message` stays the English sentence the web client shows,
 * so the web audit log keeps its exact wording and no row loses information
 * there.
 *
 * `id` is the one discriminator. It names the event, so the mobile catalog can
 * hold exactly one template per event and the compiler proves the list is
 * complete. The other fields carry values only — never a label, a noun or a
 * sentence — so a value that happens to contain English prose (an email, a
 * model id, a group name) is data the reader sees, not copy the app forgot to
 * translate. Server vocabularies that are *not* data (a role, a data region, a
 * platform) travel as their own closed tag and the catalog names them.
 *
 * One action can carry many ids. `organization.settings.change` is written from
 * more than thirty places, from a BYOK key change to a browser policy, so the
 * action cannot name the event; the id does.
 */

/**
 * A role, as the audit reader names it.
 *
 * `roles.ts` holds the single source. This module builds its validator from
 * `ORGANIZATION_ROLES`, so a role added to the canonical list is accepted here
 * the day it is added — the alternative, restating the list, would silently
 * drop a new role's detail back to the event name.
 */
export type AuditRoleTag = OrganizationRole;

/**
 * The inference region an organization can pin.
 *
 * This list is the single source. `OrganizationDataRegionSchema`, the schema of
 * `OrganizationSettings['data_region']`, is built from this tuple in
 * `@kilocode/db`, so a region added here cannot be written as a value this
 * module's validator rejects — the alternative, restating the list in both
 * packages, would silently drop a new region's detail back to the event name.
 */
export const AUDIT_REGION_TAGS = ['us', 'eu', 'au', 'jp'] as const;
export type AuditRegionTag = (typeof AUDIT_REGION_TAGS)[number];

export const AUDIT_PLATFORM_TAGS = ['github', 'gitlab', 'bitbucket'] as const;
export type AuditPlatformTag = (typeof AUDIT_PLATFORM_TAGS)[number];

/** A stored `allow`/`deny`/unset, as the audit reader's three tags. */
export const AUDIT_DATA_COLLECTION_TAGS = ['allowed', 'denied', 'followSetting'] as const;
export type AuditDataCollectionTag = (typeof AUDIT_DATA_COLLECTION_TAGS)[number];

/** The browser policy the organization stores in `browserControl`. */
export const AUDIT_BROWSER_POLICY_TAGS = [
  'allow',
  'playwright_only',
  'off',
] as const satisfies readonly string[];
export type AuditBrowserPolicyTag = (typeof AUDIT_BROWSER_POLICY_TAGS)[number];

export const AUDIT_INTEGRATION_TAGS = ['byok', 'discord', 'linear', 'slack', 'github'] as const;
export type AuditIntegrationTag = (typeof AUDIT_INTEGRATION_TAGS)[number];

/** A mode field whose value is prose, so the change lists it and not its text. */
export const AUDIT_MODE_FIELDS = [
  'name',
  'slug',
  'roleDefinition',
  'whenToUse',
  'description',
  'customInstructions',
  'groups',
  'autoRoute',
] as const;
export type AuditModeField = (typeof AUDIT_MODE_FIELDS)[number];

/** The object an enforcement setting guards, as a server vocabulary the catalog names. */
export const AUDIT_GUARDRAIL_TARGET_TAGS = ['mcp', 'skill'] as const;
export type AuditGuardrailTargetTag = (typeof AUDIT_GUARDRAIL_TARGET_TAGS)[number];

/** The scope a default behaviour applies to, as a server vocabulary the catalog names. */
export const AUDIT_DEFAULT_BEHAVIOR_TAGS = ['global', 'specific', 'auto'] as const;
export type AuditDefaultBehaviorTag = (typeof AUDIT_DEFAULT_BEHAVIOR_TAGS)[number];

const RoleTag = z.enum(ORGANIZATION_ROLES);
const RegionTag = z.enum(AUDIT_REGION_TAGS);
const PlatformTag = z.enum(AUDIT_PLATFORM_TAGS);
const DataCollectionTag = z.enum(AUDIT_DATA_COLLECTION_TAGS);
const BrowserPolicyTag = z.enum(AUDIT_BROWSER_POLICY_TAGS);
const IntegrationTag = z.enum(AUDIT_INTEGRATION_TAGS);
const ModeField = z.enum(AUDIT_MODE_FIELDS);
const GuardrailTargetTag = z.enum(AUDIT_GUARDRAIL_TARGET_TAGS);
const DefaultBehaviorTag = z.enum(AUDIT_DEFAULT_BEHAVIOR_TAGS);

/** One field a mode update changed; prose fields carry no `previous`/`next`. */
const ModeFieldChangeSchema = z.strictObject({
  field: ModeField,
  previous: z.string().optional(),
  next: z.string().optional(),
});
export type AuditModeFieldChange = z.infer<typeof ModeFieldChangeSchema>;

const ModeIdentitySchema = z.strictObject({
  name: z.string(),
  slug: z.string(),
});

// Where several events carry the same payload, the payload is written once and
// each event extends it with its own `id`. A copy of the fields per event drifts
// as soon as one arm is edited, and the drift is invisible to the compiler
// because every copy type-checks on its own.
const IntegrationKeySchema = z.strictObject({
  integration: IntegrationTag,
  provider: z.string(),
});

const NamedPolicySchema = z.strictObject({
  policyKind: z.string(),
  policyId: z.string(),
});

const MemberParentSchema = z.strictObject({
  email: z.string(),
  parent: z.string(),
});

const GroupPolicySchema = z.strictObject({
  name: z.string(),
  policyType: z.string(),
});

const GroupDefaultPolicySchema = z.strictObject({
  policyType: z.string(),
});

/**
 * Every event id, with the payload each carries. The `id` values are a closed
 * union: one template per id in the mobile catalogs.
 */
const AuditDetailSchema = z.discriminatedUnion('id', [
  // A mode's own name and identifier. Create and delete say the same thing
  // about their object, and the row's event name above them states the verb.
  ModeIdentitySchema.extend({ id: z.literal('mode.identity') }),
  ModeIdentitySchema.extend({
    id: z.literal('mode.update'),
    fields: z.array(ModeFieldChangeSchema),
  }),

  z.strictObject({
    id: z.literal('member.role'),
    email: z.string(),
    previous: RoleTag,
    next: RoleTag,
  }),
  z.strictObject({ id: z.literal('member.added'), email: z.string(), role: RoleTag }),
  z.strictObject({ id: z.literal('member.removed'), email: z.string() }),
  MemberParentSchema.extend({ id: z.literal('member.parentAdded') }),
  MemberParentSchema.extend({ id: z.literal('member.parentRemoved') }),

  z.strictObject({ id: z.literal('invite.sent'), email: z.string(), role: RoleTag }),
  z.strictObject({ id: z.literal('invite.revoked'), email: z.string() }),
  z.strictObject({ id: z.literal('invite.accepted'), email: z.string() }),

  z.strictObject({ id: z.literal('group.identity'), name: z.string() }),
  z.strictObject({ id: z.literal('group.members'), name: z.string(), count: z.number() }),
  z.strictObject({
    id: z.literal('group.memberGroups'),
    count: z.number(),
    email: z.string().optional(),
  }),
  GroupPolicySchema.extend({ id: z.literal('group.policySet') }),
  GroupPolicySchema.extend({ id: z.literal('group.policyRemoved') }),
  GroupDefaultPolicySchema.extend({ id: z.literal('group.defaultPolicySet') }),
  GroupDefaultPolicySchema.extend({ id: z.literal('group.defaultPolicyRemoved') }),

  z.strictObject({
    id: z.literal('guardrail.identity'),
    type: z.string(),
    name: z.string(),
  }),
  z.strictObject({
    id: z.literal('guardrail.status'),
    type: z.string(),
    name: z.string(),
    enabled: z.boolean(),
  }),
  z.strictObject({
    id: z.literal('guardrail.config'),
    enabled: z.boolean(),
    group: z.string().optional(),
  }),
  z.strictObject({
    id: z.literal('guardrail.enforcement'),
    target: GuardrailTargetTag,
    enforcement: z.string().optional(),
    enabled: z.boolean().optional(),
    scanBeforeUse: z.boolean().optional(),
  }),

  z.strictObject({
    id: z.literal('sso.domainSet'),
    domain: z.string(),
    previous: z.string().optional(),
  }),
  z.strictObject({ id: z.literal('sso.domainRemoved'), domain: z.string() }),

  z.strictObject({ id: z.literal('funds.purchased'), amount: z.number(), method: z.string() }),
  z.strictObject({ id: z.literal('funds.granted'), amount: z.number() }),
  z.strictObject({ id: z.literal('funds.distributed'), amount: z.number(), count: z.number() }),
  z.strictObject({ id: z.literal('funds.received'), amount: z.number(), parent: z.string() }),

  z.strictObject({ id: z.literal('reviewAgent.platform'), platform: PlatformTag }),
  z.strictObject({
    id: z.literal('reviewAgent.config'),
    platform: PlatformTag,
    style: z.string().optional(),
  }),
  z.strictObject({
    id: z.literal('reviewAgent.secretRotated'),
    updated: z.number(),
    errors: z.number(),
  }),

  // The organization settings, where the row's event name is generic and the
  // detail line is the only place that can say which setting moved.
  //
  // One row records both advanced gateway policies, so the detail names
  // whichever of them changed: a region move alone, an OpenRouter change alone,
  // or both in one save.
  z.strictObject({
    id: z.literal('setting.advancedPolicies'),
    openRouter: z.boolean().optional(),
    region: RegionTag.optional(),
  }),
  z.strictObject({
    id: z.literal('setting.defaultModel'),
    previous: z.string().optional(),
    next: z.string().optional(),
  }),
  z.strictObject({
    id: z.literal('setting.autoRoute'),
    mode: z.string(),
    previous: z.string().optional(),
    next: z.string().optional(),
  }),
  z.strictObject({
    id: z.literal('setting.defaultBehavior'),
    behavior: DefaultBehaviorTag,
    model: z.string().optional(),
  }),
  z.strictObject({ id: z.literal('setting.dataCollection'), mode: DataCollectionTag }),
  z.strictObject({ id: z.literal('setting.projectsUi'), enabled: z.boolean() }),
  z.strictObject({
    id: z.literal('setting.minimumBalanceAlert'),
    enabled: z.boolean(),
    threshold: z.number().optional(),
    emails: z.array(z.string()).optional(),
  }),
  z.strictObject({ id: z.literal('setting.recommendationsDigest'), enabled: z.boolean() }),
  z.strictObject({
    id: z.literal('setting.browserControl'),
    policy: BrowserPolicyTag,
    origins: z.array(z.string()).optional(),
  }),
  z.strictObject({ id: z.literal('setting.accessLists') }),
  z.strictObject({ id: z.literal('setting.name'), previous: z.string(), next: z.string() }),
  z.strictObject({ id: z.literal('setting.byokPriorities') }),

  // A third-party integration, where the event name is generic too.
  z.strictObject({ id: z.literal('integration.connected'), integration: IntegrationTag }),
  z.strictObject({ id: z.literal('integration.disconnected'), integration: IntegrationTag }),
  z.strictObject({
    id: z.literal('integration.modelUpdated'),
    integration: IntegrationTag,
    model: z.string(),
  }),
  z.strictObject({ id: z.literal('integration.installed'), integration: IntegrationTag }),
  z.strictObject({ id: z.literal('integration.uninstalled'), integration: IntegrationTag }),
  z.strictObject({ id: z.literal('integration.refreshed'), integration: IntegrationTag }),
  z.strictObject({ id: z.literal('integration.cancelled'), integration: IntegrationTag }),
  IntegrationKeySchema.extend({ id: z.literal('integration.keyAdded') }),
  IntegrationKeySchema.extend({ id: z.literal('integration.keyUpdated') }),
  IntegrationKeySchema.extend({ id: z.literal('integration.keyDeleted') }),
  z.strictObject({
    id: z.literal('integration.keyToggled'),
    integration: IntegrationTag,
    provider: z.string(),
    enabled: z.boolean(),
    catalogModels: z.boolean().optional(),
  }),

  z.strictObject({
    id: z.literal('autoRouting.models'),
    added: z.array(z.strictObject({ provider: z.string(), models: z.array(z.string()) })),
    removed: z.array(z.string()),
    // Models the `disable_new_models` policy put on the deny list as they became available.
    disabled: z
      .array(z.strictObject({ provider: z.string(), models: z.array(z.string()) }))
      .optional(),
  }),

  NamedPolicySchema.extend({ id: z.literal('namedPolicy.created') }),
  NamedPolicySchema.extend({ id: z.literal('namedPolicy.updated') }),
  NamedPolicySchema.extend({ id: z.literal('namedPolicy.deleted') }),
  z.strictObject({
    id: z.literal('namedPolicy.linked'),
    policyKind: z.string(),
    scope: z.string(),
    previous: z.string().optional(),
    next: z.string().optional(),
  }),

  z.strictObject({ id: z.literal('webhookTrigger.updated'), trigger: z.string() }),

  z.strictObject({ id: z.literal('token.user') }),
  z.strictObject({ id: z.literal('token.resource') }),

  z.strictObject({ id: z.literal('organization.renamed'), previous: z.string(), next: z.string() }),
]);

export type AuditDetail = z.infer<typeof AuditDetailSchema>;

/**
 * The event ids a mobile build must carry a template for.
 *
 * Derived from the schema, so adding a detail without its copy fails the type
 * check at the map that holds the templates.
 */
export type AuditDetailId = AuditDetail['id'];

/**
 * Every event id, at runtime, from the schema's own discriminators.
 *
 * The coverage test walks this list, so an id that gains no template is caught
 * even where the compiler cannot see the map.
 */
export const AUDIT_DETAIL_IDS = AuditDetailSchema.options.map(
  option => option.shape.id.value
) as readonly AuditDetailId[];

/** A stored row's payload; `null` when the row predates the contract. */
export const AuditDetailColumnSchema = AuditDetailSchema.nullable();
export type AuditDetailColumn = z.infer<typeof AuditDetailColumnSchema>;

/** Whether a stored value is a payload this build understands. */
export function parseAuditDetail(value: unknown): AuditDetail | null {
  const parsed = AuditDetailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
