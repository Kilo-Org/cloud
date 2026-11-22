import * as z from 'zod';

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

/** A server vocabulary the catalog names, never echoed as English. */
export const AUDIT_ROLE_TAGS = ['owner', 'admin', 'billing_manager', 'member'] as const;
export type AuditRoleTag = (typeof AUDIT_ROLE_TAGS)[number];

export const AUDIT_REGION_TAGS = ['global', 'eu', 'us'] as const;
export type AuditRegionTag = (typeof AUDIT_REGION_TAGS)[number];

export const AUDIT_PLATFORM_TAGS = ['github', 'gitlab', 'bitbucket'] as const;
export type AuditPlatformTag = (typeof AUDIT_PLATFORM_TAGS)[number];

export const AUDIT_DATA_COLLECTION_TAGS = ['allowed', 'denied', 'followSetting'] as const;
export type AuditDataCollectionTag = (typeof AUDIT_DATA_COLLECTION_TAGS)[number];

export const AUDIT_BROWSER_POLICY_TAGS = ['disabled', 'allowlist', 'all'] as const;
export type AuditBrowserPolicyTag = (typeof AUDIT_BROWSER_POLICY_TAGS)[number];

export const AUDIT_INTEGRATION_TAGS = [
  'byok',
  'discord',
  'linear',
  'slack',
  'github',
] as const;
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

const RoleTag = z.enum(AUDIT_ROLE_TAGS);
const RegionTag = z.enum(AUDIT_REGION_TAGS);
const PlatformTag = z.enum(AUDIT_PLATFORM_TAGS);
const DataCollectionTag = z.enum(AUDIT_DATA_COLLECTION_TAGS);
const BrowserPolicyTag = z.enum(AUDIT_BROWSER_POLICY_TAGS);
const IntegrationTag = z.enum(AUDIT_INTEGRATION_TAGS);
const ModeField = z.enum(AUDIT_MODE_FIELDS);

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
  z.strictObject({ id: z.literal('member.parentAdded'), email: z.string(), parent: z.string() }),
  z.strictObject({ id: z.literal('member.parentRemoved'), email: z.string(), parent: z.string() }),

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
  z.strictObject({ id: z.literal('group.policySet'), name: z.string(), policyType: z.string() }),
  z.strictObject({
    id: z.literal('group.policyRemoved'),
    name: z.string(),
    policyType: z.string(),
  }),

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
    target: z.enum(['mcp', 'skill']),
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
  z.strictObject({ id: z.literal('setting.openRouter'), enabled: z.boolean() }),
  z.strictObject({ id: z.literal('setting.dataRegion'), region: RegionTag }),
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
    behavior: z.enum(['global', 'specific', 'auto']),
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
  z.strictObject({
    id: z.literal('integration.keyAdded'),
    integration: IntegrationTag,
    provider: z.string(),
  }),
  z.strictObject({
    id: z.literal('integration.keyUpdated'),
    integration: IntegrationTag,
    provider: z.string(),
  }),
  z.strictObject({
    id: z.literal('integration.keyDeleted'),
    integration: IntegrationTag,
    provider: z.string(),
  }),
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
  }),

  z.strictObject({
    id: z.literal('namedPolicy.created'),
    policyKind: z.string(),
    policyId: z.string(),
  }),
  z.strictObject({
    id: z.literal('namedPolicy.updated'),
    policyKind: z.string(),
    policyId: z.string(),
  }),
  z.strictObject({
    id: z.literal('namedPolicy.deleted'),
    policyKind: z.string(),
    policyId: z.string(),
  }),
  z.strictObject({
    id: z.literal('namedPolicy.linked'),
    policyKind: z.string(),
    scope: z.string(),
    previous: z.string().optional(),
    next: z.string().optional(),
  }),

  z.strictObject({ id: z.literal('webhookTrigger.updated'), trigger: z.string() }),

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

/** A stored row's payload; `null` when the row predates the contract. */
export const AuditDetailColumnSchema = AuditDetailSchema.nullable();
export type AuditDetailColumn = z.infer<typeof AuditDetailColumnSchema>;

/** Whether a stored value is a payload this build understands. */
export function parseAuditDetail(value: unknown): AuditDetail | null {
  const parsed = AuditDetailSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
