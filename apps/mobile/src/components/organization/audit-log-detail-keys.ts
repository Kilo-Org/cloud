import { type TFunction } from 'i18next';

import { type OrganizationAuditLogDetails } from '@kilocode/db/schema-types';

import { formatPrefixedMoney } from '@/lib/format';
import { i18n } from '@/i18n';

// The catalog keys the audit detail builder reads, one complete literal per
// entry — the catalog checker reads the keys off these maps, so a derived
// template-literal key would leave the read unable to verify the catalogs.

export const ROLE_KEYS = {
  owner: 'organization.auditLog.detail.role.owner',
  admin: 'organization.auditLog.detail.role.admin',
  member: 'organization.auditLog.detail.role.member',
  billing_manager: 'organization.auditLog.detail.role.billing_manager',
} as const;

export const POLICY_TYPE_KEYS = {
  model_access: 'organization.auditLog.detail.policyType.model_access',
} as const;

// The platform labels reuse the catalog keys those names already have, so each
// name holds one wording per catalog.
export const PLATFORM_KEYS = {
  github: 'common.github',
  gitlab: 'common.gitlab',
  bitbucket: 'agentChat.repoPicker.platformBitbucket',
  linear: 'agentChat.sessionFilter.platformLinear',
  slack: 'agentChat.sessionFilter.platformSlack',
  discord: 'profile.providerDiscord',
} as const;

export const BYOK_VERB_KEYS = {
  added: 'organization.auditLog.detail.byok.added',
  removed: 'organization.auditLog.detail.byok.removed',
  enabled: 'organization.auditLog.detail.byok.enabled',
  disabled: 'organization.auditLog.detail.byok.disabled',
  catalog_enabled: 'organization.auditLog.detail.byok.catalog_enabled',
  catalog_disabled: 'organization.auditLog.detail.byok.catalog_disabled',
  updated: 'organization.auditLog.detail.byok.updated',
} as const;

export const BITBUCKET_WORKSPACE_KEYS = {
  connected: 'organization.auditLog.detail.bitbucketWorkspace.connected',
  rotated: 'organization.auditLog.detail.bitbucketWorkspace.rotated',
  disconnected: 'organization.auditLog.detail.bitbucketWorkspace.disconnected',
} as const;

export const DATA_COLLECTION_KEYS = {
  allowed: 'organization.auditLog.detail.dataCollection.allowed',
  denied: 'organization.auditLog.detail.dataCollection.denied',
  follow_extension_setting: 'organization.auditLog.detail.dataCollection.follow_extension_setting',
} as const;

export const MCP_TYPE_KEYS = {
  mcp: 'organization.auditLog.detail.mcpType.mcp',
  skill: 'organization.auditLog.detail.mcpType.skill',
} as const;

const DETECTOR_ID_KEYS = {
  injection_attack: 'organizationGuardrails.detector.promptInjection.label',
  policy_violation: 'organizationGuardrails.detector.policyViolation.label',
  pii: 'organizationGuardrails.detector.pii.label',
  keyword_detector: 'organizationGuardrails.detector.keywords.label',
  topic_detector: 'organizationGuardrails.detector.topics.label',
  toxicity: 'organizationGuardrails.detector.toxicity.label',
  nsfw: 'organizationGuardrails.detector.nsfw.label',
  bias: 'organizationGuardrails.detector.bias.label',
  sponge_attack: 'organizationGuardrails.detector.spongeAttack.label',
} as const;

const PII_ENTITY_KEYS = {
  pii: 'organizationGuardrails.pii.personalData.label',
  secrets: 'organizationGuardrails.pii.secrets.label',
  ip_address: 'organizationGuardrails.pii.ipAddress.label',
  url: 'organizationGuardrails.pii.url.label',
} as const;

type GuardrailsInputDetails = Extract<OrganizationAuditLogDetails, { kind: 'guardrails_input' }>;

type DetectorDetails = GuardrailsInputDetails['detectors'][number];

type PiiEntity = NonNullable<DetectorDetails['entities']>[number];

// The detector label map covers the input side; the output side reuses the same
// ids where they overlap. An id the map does not name shows the raw id, the way
// an unmatched key does elsewhere in this file.
function detectorLabel(t: TFunction, id: string): string {
  // A runtime id outside the map cannot appear in this type, but a future
  // detector must not render a missing-key string. `Object.hasOwn` keeps the
  // map's own type intact while checking the runtime key.
  if (!Object.hasOwn(DETECTOR_ID_KEYS, id)) {
    return id;
  }
  return t(DETECTOR_ID_KEYS[id as keyof typeof DETECTOR_ID_KEYS]);
}

function piiEntityLabel(t: TFunction, entity: PiiEntity): string {
  return t(PII_ENTITY_KEYS[entity]);
}

/**
 * The fragment that states one detector as the admin saved it, in the reader's
 * language: "Policy violation (3 rules)". Disabled detectors are omitted — the
 * sentence describes what the save leaves running.
 */
function describeDetailDetector(t: TFunction, detector: DetectorDetails): string | null {
  if (!detector.enabled) {
    return null;
  }
  const label = detectorLabel(t, detector.id);
  const extra: string[] = [];
  if (detector.action === 'log') {
    extra.push(t('organizationGuardrails.choiceLog'));
  }
  if (detector.entities) {
    extra.push(detector.entities.map(entity => piiEntityLabel(t, entity)).join(', '));
  }
  if (detector.keywordsCount != null) {
    extra.push(t('organization.auditLog.detail.keywordsCount', { count: detector.keywordsCount }));
  }
  if (detector.topicsCount != null) {
    extra.push(t('organization.auditLog.detail.topicsCount', { count: detector.topicsCount }));
  }
  if (detector.rulesCount != null) {
    extra.push(t('organization.auditLog.detail.rulesCount', { count: detector.rulesCount }));
  }
  if (detector.policyText) {
    extra.push(t('organization.auditLog.detail.policyText'));
  }
  return extra.length > 0 ? `${label} (${extra.join(', ')})` : label;
}

export function describeDetectors(t: TFunction, detectors: readonly DetectorDetails[]): string {
  const enabled = detectors.flatMap(detector => describeDetailDetector(t, detector) ?? []);
  return enabled.length > 0 ? enabled.join(', ') : t('organization.auditLog.detail.detectorsNone');
}

export const GITHUB_VERB_KEYS = {
  model_changed: 'organization.auditLog.detail.githubModelChanged',
  uninstalled: 'organization.auditLog.detail.githubUninstalled',
  refreshed: 'organization.auditLog.detail.githubRefreshed',
  cancel_pending: 'organization.auditLog.detail.githubCancelPending',
} as const;

export const REGION_KEYS = {
  us: 'organizationModelAccess.region.us',
  eu: 'organizationModelAccess.region.eu',
  au: 'organizationModelAccess.region.au',
  jp: 'organizationModelAccess.region.jp',
} as const;

export const BEHAVIOR_KEYS = {
  organization_auto: 'organization.auditLog.detail.defaultBehaviorAuto',
  disabled_auto: 'organization.auditLog.detail.defaultBehaviorDisabledAuto',
  reset_to_global: 'organization.auditLog.detail.defaultBehaviorResetGlobal',
} as const;

export function stateLabel(t: TFunction, enabled: boolean): string {
  return t(
    enabled ? 'organization.auditLog.detail.enabled' : 'organization.auditLog.detail.disabled'
  );
}

/** The app's one money shape for an integer cent amount: the symbol leads the number. */
export function formatDollarsFromCents(cents: number): string {
  return formatPrefixedMoney(cents / 100, i18n.language);
}
