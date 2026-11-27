/* eslint-disable max-lines -- the audit log's event vocabulary: one catalog sentence per event id, which the union's own tags key, so the table cannot hide an event behind a runtime lookup */
import {
  type AuditDetail,
  type AuditModeField,
  parseAuditDetail,
} from '@kilocode/app-shared/organizations';
import { type TFunction } from 'i18next';

import { isolateBidiText, isolateLtrBidiText } from '@/lib/bidi';
import { formatList, formatNumber, formatPrefixedMoney } from '@/lib/format';

/**
 * The row's detail line in the reader's language, from the structured event the
 * server stored beside its English message.
 *
 * The English message is never shown here: it is the web client's sentence, and
 * a mobile row that printed it would put an English sentence inside a screen the
 * reader chose to read in their own language. A row written before the server
 * stored details, a row whose stored shape this build does not understand, and
 * an event whose name already says everything, return `undefined`; the row then
 * shows its localized event name alone.
 */
export function auditEntryDetail(
  t: TFunction,
  locale: string,
  storedDetails: unknown
): string | undefined {
  const detail = parseAuditDetail(storedDetails);
  if (detail === null) {
    return undefined;
  }
  const render = renderAuditDetail(detail, {
    t,
    locale,
    isolated: isolateBidiText,
    list: (values: readonly string[]) => formatList(values, locale),
    state: (enabled: boolean) =>
      t(enabled ? 'organization.auditLog.detail.enabled' : 'organization.auditLog.detail.disabled'),
    change: (previous: string, next: string) => isolateLtrBidiText(`${previous} → ${next}`),
  });
  return render === undefined ? undefined : t(render.key, render.values);
}

/** The parts every case would otherwise repeat. */
type Tools = Readonly<{
  t: TFunction;
  /** The reader's language, for a value the platform formats (money). */
  locale: string;
  isolated: (value: string) => string;
  list: (values: readonly string[]) => string;
  state: (enabled: boolean) => string;
  /**
   * An old value and a new value as one run read left to right. A paragraph in
   * a right-to-left language would otherwise lay the pair out right to left and
   * the reader would take the new value for the old one.
   */
  change: (previous: string, next: string) => string;
}>;

/** One sentence: its catalog key and the values it interpolates. */
type Render = Readonly<{
  key: string;
  /** An absent value is left out of the sentence by i18next. */
  values: Record<string, string | number | undefined>;
}>;

/**
 * The table: one sentence per event id.
 *
 * Members stay optional because some ids deliberately render no sentence. The
 * mapped type still makes every union id a declared member and every member's
 * parameter exactly its own detail variant, so the compiler rejects a
 * misspelled id or a wrongly typed entry; that every id is classified (rendered
 * or deliberately bare) is what the coverage test in `audit-log-detail.test.ts`
 * proves.
 */
type AuditTemplates = {
  readonly [K in AuditDetail['id']]?: (
    detail: Extract<AuditDetail, { id: K }>
  ) => Render | undefined;
};

type AuditRole = 'owner' | 'admin' | 'billing_manager' | 'member';
type AuditPlatform = 'github' | 'gitlab' | 'bitbucket';
type AuditRegion = 'us' | 'eu' | 'au' | 'jp';
type AuditDataCollection = 'allowed' | 'denied' | 'followSetting';
type AuditBrowserPolicy = 'allow' | 'playwright_only' | 'off';
type AuditIntegration = 'byok' | 'discord' | 'linear' | 'slack' | 'github';
type AuditDefaultBehavior = 'global' | 'specific' | 'auto';
type AuditGuardrailTarget = 'mcp' | 'skill';

// Each map names the catalog key for one server tag, so the key check reads a
// key rather than a runtime-built string, and a tag the union gains fails here.
const ROLE_KEYS = {
  owner: 'organization.auditLog.detail.role.owner',
  admin: 'organization.auditLog.detail.role.admin',
  billing_manager: 'organization.auditLog.detail.role.billing_manager',
  member: 'organization.auditLog.detail.role.member',
} as const satisfies Record<AuditRole, string>;

const FIELD_KEYS = {
  name: 'organization.auditLog.detail.field.name',
  slug: 'organization.auditLog.detail.field.slug',
  roleDefinition: 'organization.auditLog.detail.field.roleDefinition',
  whenToUse: 'organization.auditLog.detail.field.whenToUse',
  description: 'organization.auditLog.detail.field.description',
  customInstructions: 'organization.auditLog.detail.field.customInstructions',
  groups: 'organization.auditLog.detail.field.groups',
  autoRoute: 'organization.auditLog.detail.field.autoRoute',
} as const satisfies Record<AuditModeField, string>;

/** The one field label a setting detail uses, alongside `FIELD_KEYS`. */
const DEFAULT_MODEL_FIELD_KEY = 'organization.auditLog.detail.field.defaultModel';

const PLATFORM_KEYS = {
  github: 'organization.auditLog.detail.brand.github',
  gitlab: 'organization.auditLog.detail.brand.gitlab',
  bitbucket: 'organization.auditLog.detail.brand.bitbucket',
} as const satisfies Record<AuditPlatform, string>;

const REGION_KEYS = {
  us: 'organization.auditLog.detail.region.us',
  eu: 'organization.auditLog.detail.region.eu',
  au: 'organization.auditLog.detail.region.au',
  jp: 'organization.auditLog.detail.region.jp',
} as const satisfies Record<AuditRegion, string>;

const DATA_COLLECTION_KEYS = {
  allowed: 'organization.auditLog.detail.dataCollection.allowed',
  denied: 'organization.auditLog.detail.dataCollection.denied',
  followSetting: 'organization.auditLog.detail.dataCollection.followSetting',
} as const satisfies Record<AuditDataCollection, string>;

const BROWSER_POLICY_KEYS = {
  allow: 'organization.auditLog.detail.browserPolicyAllow',
  playwright_only: 'organization.auditLog.detail.browserPolicyPlaywrightOnly',
  off: 'organization.auditLog.detail.browserPolicyOff',
} as const satisfies Record<AuditBrowserPolicy, string>;

const INTEGRATION_KEYS = {
  byok: 'organization.auditLog.detail.brand.byok',
  discord: 'organization.auditLog.detail.brand.discord',
  linear: 'organization.auditLog.detail.brand.linear',
  slack: 'organization.auditLog.detail.brand.slack',
  github: 'organization.auditLog.detail.brand.github',
} as const satisfies Record<AuditIntegration, string>;

const GUARDRAIL_TARGET_KEYS = {
  mcp: 'organization.auditLog.detail.guardrailTarget.mcp',
  skill: 'organization.auditLog.detail.guardrailTarget.skill',
} as const satisfies Record<AuditGuardrailTarget, string>;

const DEFAULT_BEHAVIOR_KEYS = {
  global: 'organization.auditLog.detail.settingDefaultBehavior.global',
  specific: 'organization.auditLog.detail.settingDefaultBehavior.specific',
  auto: 'organization.auditLog.detail.settingDefaultBehavior.auto',
} as const satisfies Record<AuditDefaultBehavior, string>;

/**
 * One `Render` per stored shape.
 *
 * The map is keyed by `AuditDetail['id']`, so each entry agrees with the union:
 * a misspelled id or a wrongly typed detail is a type error. An entry is
 * optional because some ids render no sentence, so coverage of every id is
 * proven by the test, not by this annotation.
 */
function renderAuditDetail(detail: AuditDetail, tools: Tools): Render | undefined {
  const { t, locale, isolated, list, state, change } = tools;
  const templates: AuditTemplates = {
    'mode.identity': d => ({
      key: 'organization.auditLog.detail.modeIdentity',
      values: { name: isolated(d.name), slug: isolated(d.slug) },
    }),
    // A save that carried no field change has nothing to list, and the
    // sentence ends in a bare colon, so it falls back to the mode's identity.
    'mode.update': d => {
      // A save that carried no field change has nothing to list, and the
      // sentence would end in a bare colon, so it falls back to the identity.
      if (d.fields.length === 0) {
        return {
          key: 'organization.auditLog.detail.modeIdentity',
          values: { name: isolated(d.name), slug: isolated(d.slug) },
        };
      }
      return {
        key: 'organization.auditLog.detail.modeUpdate',
        values: {
          name: isolated(d.name),
          slug: isolated(d.slug),
          changes: list(
            d.fields.map(entry => {
              const field = t(FIELD_KEYS[entry.field]);
              if (entry.previous === undefined || entry.next === undefined) {
                return field;
              }
              return t('organization.auditLog.detail.fieldChange', {
                field,
                change: change(entry.previous, entry.next),
              });
            })
          ),
        },
      };
    },

    'member.role': d => ({
      key: 'organization.auditLog.detail.memberRole',
      values: {
        email: isolated(d.email),
        change: change(t(ROLE_KEYS[d.previous]), t(ROLE_KEYS[d.next])),
      },
    }),
    'member.added': d => ({
      key: 'organization.auditLog.detail.memberAdded',
      values: { email: isolated(d.email), role: t(ROLE_KEYS[d.role]) },
    }),
    'member.removed': d => ({
      key: 'organization.auditLog.detail.memberRemoved',
      values: { email: isolated(d.email) },
    }),
    'member.parentAdded': d => ({
      key: 'organization.auditLog.detail.memberParentAdded',
      values: { email: isolated(d.email), parent: isolated(d.parent) },
    }),
    'member.parentRemoved': d => ({
      key: 'organization.auditLog.detail.memberParentRemoved',
      values: { email: isolated(d.email), parent: isolated(d.parent) },
    }),

    'invite.sent': d => ({
      key: 'organization.auditLog.detail.inviteSent',
      values: { email: isolated(d.email), role: t(ROLE_KEYS[d.role]) },
    }),
    'invite.revoked': d => ({
      key: 'organization.auditLog.detail.inviteRevoked',
      values: { email: isolated(d.email) },
    }),
    'invite.accepted': d => ({
      key: 'organization.auditLog.detail.inviteAccepted',
      values: { email: isolated(d.email) },
    }),

    'group.identity': d => ({
      key: 'organization.auditLog.detail.groupIdentity',
      values: { name: isolated(d.name) },
    }),
    // The count reads from the groups screen's plural family, so one member is
    // singular in every catalog rather than a flat "1 members".
    'group.members': d => ({
      key: 'organization.auditLog.detail.groupMembers',
      values: {
        name: isolated(d.name),
        members: t('organization.groups.memberCount', {
          count: d.count,
          displayCount: formatNumber(d.count, locale),
        }),
      },
    }),
    // The count reads from this sentence's own plural family, so one group is
    // singular in every catalog rather than a flat "1 groups", and the figure
    // itself is the reader's own numerals.
    'group.memberGroups': d => {
      const values = { count: d.count, displayCount: formatNumber(d.count, locale) };
      return d.email === undefined
        ? { key: 'organization.auditLog.detail.groupMemberGroups', values }
        : {
            key: 'organization.auditLog.detail.groupMemberGroupsOf',
            values: { ...values, email: isolated(d.email) },
          };
    },
    'group.policySet': d => ({
      key: 'organization.auditLog.detail.groupPolicySet',
      values: { name: isolated(d.name), policy: isolated(d.policyType) },
    }),
    'group.policyRemoved': d => ({
      key: 'organization.auditLog.detail.groupPolicyRemoved',
      values: { name: isolated(d.name), policy: isolated(d.policyType) },
    }),
    'group.defaultPolicySet': d => ({
      key: 'organization.auditLog.detail.groupDefaultPolicySet',
      values: { policy: isolated(d.policyType) },
    }),
    'group.defaultPolicyRemoved': d => ({
      key: 'organization.auditLog.detail.groupDefaultPolicyRemoved',
      values: { policy: isolated(d.policyType) },
    }),

    'guardrail.identity': d => ({
      key: 'organization.auditLog.detail.guardrailIdentity',
      values: { type: isolated(d.type), name: isolated(d.name) },
    }),
    'guardrail.status': d => ({
      key: 'organization.auditLog.detail.guardrailStatus',
      values: { type: isolated(d.type), name: isolated(d.name), state: state(d.enabled) },
    }),
    'guardrail.config': d =>
      d.group === undefined
        ? {
            key: 'organization.auditLog.detail.guardrailConfig',
            values: { state: state(d.enabled) },
          }
        : {
            key: 'organization.auditLog.detail.guardrailConfigGroup',
            values: { state: state(d.enabled), group: isolated(d.group) },
          },
    'guardrail.enforcement': d => {
      const target = t(GUARDRAIL_TARGET_KEYS[d.target]);
      if (d.target === 'mcp') {
        return {
          key: 'organization.auditLog.detail.guardrailEnforcement',
          values: { target, value: d.enforcement === undefined ? '' : isolated(d.enforcement) },
        };
      }
      const values: string[] = [];
      if (d.enabled !== undefined) {
        values.push(state(d.enabled));
      }
      if (d.scanBeforeUse !== undefined) {
        values.push(
          t(
            d.scanBeforeUse
              ? 'organization.auditLog.detail.scanBeforeUseOn'
              : 'organization.auditLog.detail.scanBeforeUseOff'
          )
        );
      }
      return {
        key: 'organization.auditLog.detail.guardrailSkill',
        values: { target, values: list(values) },
      };
    },

    'sso.domainSet': d =>
      d.previous === undefined
        ? {
            key: 'organization.auditLog.detail.ssoDomainSet',
            values: { domain: isolated(d.domain) },
          }
        : {
            key: 'organization.auditLog.detail.ssoDomainChanged',
            values: { previous: isolated(d.previous), domain: isolated(d.domain) },
          },
    'sso.domainRemoved': d => ({
      key: 'organization.auditLog.detail.ssoDomainRemoved',
      values: { domain: isolated(d.domain) },
    }),

    'funds.purchased': d => ({
      key: 'organization.auditLog.detail.fundsPurchased',
      values: { amount: usd(d.amount, locale), method: isolated(d.method) },
    }),
    'funds.granted': d => ({
      key: 'organization.auditLog.detail.fundsGranted',
      values: { amount: usd(d.amount, locale) },
    }),
    'funds.distributed': d => ({
      key: 'organization.auditLog.detail.fundsDistributed',
      values: {
        amount: usd(d.amount, locale),
        count: d.count,
        displayCount: formatNumber(d.count, locale),
      },
    }),
    'funds.received': d => ({
      key: 'organization.auditLog.detail.fundsReceived',
      values: { amount: usd(d.amount, locale), parent: isolated(d.parent) },
    }),

    'reviewAgent.platform': d => ({
      key: 'organization.auditLog.detail.reviewAgentPlatform',
      values: { platform: t(PLATFORM_KEYS[d.platform]) },
    }),
    'reviewAgent.config': d =>
      d.style === undefined
        ? {
            key: 'organization.auditLog.detail.reviewAgentConfig',
            values: { platform: t(PLATFORM_KEYS[d.platform]) },
          }
        : {
            key: 'organization.auditLog.detail.reviewAgentConfigStyle',
            values: { platform: t(PLATFORM_KEYS[d.platform]), style: isolated(d.style) },
          },
    // Two counts in one sentence, and i18next selects a plural form from one
    // count per key, so each count is its own family and the sentence joins the
    // two finished clauses in the reader's own list conjunction.
    'reviewAgent.secretRotated': d => ({
      key: 'organization.auditLog.detail.reviewAgentSecretRotated',
      values: {
        values: list([
          t('organization.auditLog.detail.reviewAgentSecretsUpdated', {
            count: d.updated,
            displayCount: formatNumber(d.updated, locale),
          }),
          t('organization.auditLog.detail.reviewAgentSecretsFailed', {
            count: d.errors,
            displayCount: formatNumber(d.errors, locale),
          }),
        ]),
      },
    }),

    'setting.advancedPolicies': d => {
      const parts: string[] = [];
      if (d.openRouter !== undefined) {
        parts.push(
          t('organization.auditLog.detail.settingAdvancedPoliciesOpenRouter', {
            state: state(d.openRouter),
          })
        );
      }
      if (d.region !== undefined) {
        parts.push(
          t('organization.auditLog.detail.settingAdvancedPoliciesRegion', {
            region: t(REGION_KEYS[d.region]),
          })
        );
      }
      return parts.length === 0
        ? undefined
        : {
            key: 'organization.auditLog.detail.settingAdvancedPolicies',
            values: { values: list(parts) },
          };
    },
    'setting.defaultModel': d => defaultModelRow(d, tools),
    // The sentence reads "<old> → <new>", so it needs both arms. A route that
    // was only set, or only cleared, has one, and the row shows its event name
    // alone rather than a dangling arrow.
    'setting.autoRoute': d =>
      d.previous === undefined || d.next === undefined
        ? undefined
        : {
            key: 'organization.auditLog.detail.settingAutoRoute',
            values: {
              mode: isolated(d.mode),
              change: change(d.previous, d.next),
            },
          },
    'setting.defaultBehavior': d => ({
      key: DEFAULT_BEHAVIOR_KEYS[d.behavior],
      values: { model: d.model === undefined ? '' : isolated(d.model) },
    }),
    'setting.dataCollection': d => ({
      key: 'organization.auditLog.detail.settingDataCollection',
      values: { mode: t(DATA_COLLECTION_KEYS[d.mode]) },
    }),
    'setting.projectsUi': d => ({
      key: 'organization.auditLog.detail.settingProjectsUi',
      values: { state: state(d.enabled) },
    }),
    // The sentence names the recipients, so it needs them. A row whose list is
    // absent or was emptied — the account-deletion scrub drops a deleted
    // address and the key with it — states the threshold alone rather than
    // dangling a `to` with nothing after it.
    'setting.minimumBalanceAlert': d => {
      if (!d.enabled) {
        return undefined;
      }
      const threshold = usd(d.threshold ?? 0, locale);
      return d.emails === undefined || d.emails.length === 0
        ? {
            key: 'organization.auditLog.detail.settingMinimumBalanceThreshold',
            values: { threshold },
          }
        : {
            key: 'organization.auditLog.detail.settingMinimumBalanceOn',
            values: {
              threshold,
              emails: list(d.emails.map(value => isolated(value))),
            },
          };
    },
    'setting.recommendationsDigest': d => ({
      key: 'organization.auditLog.detail.settingRecommendationsDigest',
      values: { state: state(d.enabled) },
    }),
    // A save can move the allowed origins while leaving the policy alone, so a
    // row that carries origins states them; naming only the policy would hide
    // the change. A save that clears the list carries an empty one, which is
    // also a change, so it says the list is now empty. A row without origins
    // keeps the policy alone.
    'setting.browserControl': d => {
      const policy = t(BROWSER_POLICY_KEYS[d.policy]);
      if (d.origins === undefined) {
        return { key: 'organization.auditLog.detail.settingBrowserControl', values: { policy } };
      }
      if (d.origins.length === 0) {
        return {
          key: 'organization.auditLog.detail.settingBrowserControlOriginsCleared',
          values: { policy },
        };
      }
      return {
        key: 'organization.auditLog.detail.settingBrowserControlOrigins',
        values: { policy, origins: list(d.origins.map(value => isolated(value))) },
      };
    },
    // The event name above the row already says what these three carry.
    'setting.accessLists': () => undefined,
    'setting.name': d => ({
      key: 'organization.auditLog.detail.settingName',
      values: { previous: isolated(d.previous), next: isolated(d.next) },
    }),
    'setting.byokPriorities': () => undefined,

    'integration.connected': d => integration(tools, d.integration, 'integrationConnected'),
    'integration.disconnected': d => integration(tools, d.integration, 'integrationDisconnected'),
    'integration.modelUpdated': d => ({
      key: 'organization.auditLog.detail.integrationModelUpdated',
      values: { integration: t(INTEGRATION_KEYS[d.integration]), model: isolated(d.model) },
    }),
    'integration.installed': d => integration(tools, d.integration, 'integrationConnected'),
    'integration.uninstalled': d => integration(tools, d.integration, 'integrationDisconnected'),
    'integration.refreshed': d => integration(tools, d.integration, 'integrationRefreshed'),
    'integration.cancelled': d => integration(tools, d.integration, 'integrationCancelled'),
    'integration.keyAdded': d => keyEvent(tools, d.provider, 'integrationKeyAdded'),
    'integration.keyUpdated': d => keyEvent(tools, d.provider, 'integrationKeyUpdated'),
    'integration.keyDeleted': d => keyEvent(tools, d.provider, 'integrationKeyDeleted'),
    // The one sentence reports the key's own on/off state. A catalog-model
    // toggle carries a different fact, so its row shows the event name alone
    // instead of the key's state, which can read the opposite way.
    'integration.keyToggled': d =>
      d.catalogModels === undefined
        ? {
            key: 'organization.auditLog.detail.integrationKeyToggled',
            values: { provider: isolated(d.provider), state: state(d.enabled) },
          }
        : undefined,

    'autoRouting.models': d => {
      const parts: string[] = [];
      for (const group of d.added) {
        parts.push(
          t('organization.auditLog.detail.autoRoutingAdded', {
            provider: isolated(group.provider),
            models: list(group.models.map(value => isolated(value))),
          })
        );
      }
      for (const group of d.disabled ?? []) {
        parts.push(
          t('organization.auditLog.detail.autoRoutingDisabled', {
            provider: isolated(group.provider),
            models: list(group.models.map(value => isolated(value))),
          })
        );
      }
      if (d.removed.length > 0) {
        parts.push(
          t('organization.auditLog.detail.autoRoutingRemoved', {
            models: list(d.removed.map(value => isolated(value))),
          })
        );
      }
      return parts.length === 0
        ? undefined
        : { key: 'organization.auditLog.detail.autoRouting', values: { values: list(parts) } };
    },

    'namedPolicy.created': d => policyEvent(tools, d, 'namedPolicyCreated'),
    'namedPolicy.updated': d => policyEvent(tools, d, 'namedPolicyUpdated'),
    'namedPolicy.deleted': d => policyEvent(tools, d, 'namedPolicyDeleted'),
    // The one sentence names the policy that is now linked. A removal has no
    // policy to name, so the row shows its event name alone rather than
    // "Linked … " with nothing after it.
    'namedPolicy.linked': d =>
      d.next === undefined
        ? undefined
        : {
            key: 'organization.auditLog.detail.namedPolicyLinked',
            values: { kind: isolated(d.policyKind), next: isolated(d.next) },
          },

    'webhookTrigger.updated': d => ({
      key: 'organization.auditLog.detail.webhookTriggerUpdated',
      values: { trigger: isolated(d.trigger) },
    }),

    // The event name already names the token kind.
    'token.user': () => undefined,
    'token.resource': () => undefined,

    'organization.renamed': d => ({
      key: 'organization.auditLog.detail.organizationRenamed',
      values: { previous: isolated(d.previous), next: isolated(d.next) },
    }),
  };

  // One lookup per event. The cast is the join the union cannot express on its
  // own: `detail.id` selects an entry, and that entry's parameter is exactly
  // `detail`. `AuditTemplates` above checks each entry against the union; that
  // every id has one is the coverage test's job.
  const template = templates[detail.id] as
    | ((detail: AuditDetail) => Render | undefined)
    | undefined;
  return template?.(detail);
}

/**
 * A credit amount in the reader's own digits: the app's one money shape keeps
 * the `$` prefix and takes the separators from the catalog's language, so a
 * Japanese row does not print English grouping.
 */
function usd(amount: number, locale: string): string {
  return formatPrefixedMoney(Math.abs(amount), locale);
}

/** The integration events that name only the service. */
function integration(tools: Tools, name: AuditIntegration, template: IntegrationKey): Render {
  return {
    key: INTEGRATION_TEMPLATE_KEYS[template],
    values: { integration: tools.t(INTEGRATION_KEYS[name]) },
  };
}

type IntegrationKey =
  | 'integrationConnected'
  | 'integrationDisconnected'
  | 'integrationRefreshed'
  | 'integrationCancelled';

const INTEGRATION_TEMPLATE_KEYS = {
  integrationConnected: 'organization.auditLog.detail.integrationConnected',
  integrationDisconnected: 'organization.auditLog.detail.integrationDisconnected',
  integrationRefreshed: 'organization.auditLog.detail.integrationRefreshed',
  integrationCancelled: 'organization.auditLog.detail.integrationCancelled',
} as const satisfies Record<IntegrationKey, string>;

/** A BYOK key event, which names the provider and nothing else. */
function keyEvent(tools: Tools, provider: string, template: KeyEventKey): Render {
  return { key: KEY_EVENT_TEMPLATE_KEYS[template], values: { provider: tools.isolated(provider) } };
}

type KeyEventKey = 'integrationKeyAdded' | 'integrationKeyUpdated' | 'integrationKeyDeleted';

const KEY_EVENT_TEMPLATE_KEYS = {
  integrationKeyAdded: 'organization.auditLog.detail.integrationKeyAdded',
  integrationKeyUpdated: 'organization.auditLog.detail.integrationKeyUpdated',
  integrationKeyDeleted: 'organization.auditLog.detail.integrationKeyDeleted',
} as const satisfies Record<KeyEventKey, string>;

/** A named-policy event that names the policy kind and the policy. */
function policyEvent(
  tools: Tools,
  detail: Extract<
    AuditDetail,
    { id: 'namedPolicy.created' | 'namedPolicy.updated' | 'namedPolicy.deleted' }
  >,
  template: PolicyEventKey
): Render {
  return {
    key: POLICY_EVENT_TEMPLATE_KEYS[template],
    values: { kind: tools.isolated(detail.policyKind), id: tools.isolated(detail.policyId) },
  };
}

type PolicyEventKey = 'namedPolicyCreated' | 'namedPolicyUpdated' | 'namedPolicyDeleted';

const POLICY_EVENT_TEMPLATE_KEYS = {
  namedPolicyCreated: 'organization.auditLog.detail.namedPolicyCreated',
  namedPolicyUpdated: 'organization.auditLog.detail.namedPolicyUpdated',
  namedPolicyDeleted: 'organization.auditLog.detail.namedPolicyDeleted',
} as const satisfies Record<PolicyEventKey, string>;

/**
 * A default-model change, which reads as set, removed or a move.
 *
 * Written as early returns rather than one nested conditional: the three cases
 * carry different sentences, and a reader should not have to count `?`s to find
 * the one they want.
 */
function defaultModelRow(
  detail: Extract<AuditDetail, { id: 'setting.defaultModel' }>,
  tools: Tools
): Render | undefined {
  const { t, isolated, change } = tools;
  if (detail.previous === undefined) {
    if (detail.next === undefined) {
      return undefined;
    }
    return {
      key: 'organization.auditLog.detail.settingDefaultModelSet',
      values: { next: isolated(detail.next) },
    };
  }
  if (detail.next === undefined) {
    return {
      key: 'organization.auditLog.detail.settingDefaultModelRemoved',
      values: { previous: isolated(detail.previous) },
    };
  }
  return {
    key: 'organization.auditLog.detail.fieldChange',
    values: {
      field: t(DEFAULT_MODEL_FIELD_KEY),
      change: change(detail.previous, detail.next),
    },
  };
}
