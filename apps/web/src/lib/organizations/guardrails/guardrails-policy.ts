import type {
  OrganizationGuardrailConfig,
  OrganizationGuardrailEnforcement,
  OrganizationMcpGuardrailConfig,
} from '@kilocode/db/schema-types';
import type { Organization, OrganizationGuardrail } from '@kilocode/db/schema';
import { organization_guardrails } from '@kilocode/db/schema';
import {
  resolveEnkryptInputGuardrail,
  resolveEnkryptOutputGuardrail,
} from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import { isKiloEncryptEnabled } from '../kilo-encrypt';
import {
  mcpIdentityKey,
  normalizePackageIdentifier,
  normalizeRemoteMcpUrl,
  type McpTarget,
} from './mcp-identity';
import {
  checkVersion,
  classifyLegacyMinVersion,
  isValidVersionSpec,
  minimumVersionForSpec,
  type VersionCheckResult,
} from './version-spec';

/** Matches the identity key length accepted by the admin audit log endpoints. */
export const MAX_MCP_IDENTITY_KEY_LENGTH = 500;

export type AllowedMcpServer = {
  identityKey: string;
  name: string;
  description: string | null;
  config: OrganizationMcpGuardrailConfig;
};

/** `buffersResponses`: a response detector blocks, so streamed responses arrive all at once. */
export type OrganizationGuardrailsPolicy = {
  inputScan: { enabled: boolean; scanToolResults: boolean };
  outputScan: { enabled: boolean; buffersResponses: boolean };
  mcp: {
    enforcement: OrganizationGuardrailEnforcement;
    allowedServers: AllowedMcpServer[];
  };
  skill: { enabled: boolean; scanBeforeUse: boolean };
};

type GuardrailSettingsOrganization = Pick<Organization, 'id' | 'settings'>;

/**
 * What the organization's clients must apply. Organizations Kilo admins have not granted AI
 * Guardrails (`kilo_encrypt`) get everything off, whatever their saved settings say, so clients
 * never have to handle a "not available" error.
 */
export function resolveGuardrailsSettings(organization: GuardrailSettingsOrganization): {
  inputScan: OrganizationGuardrailsPolicy['inputScan'];
  outputScan: OrganizationGuardrailsPolicy['outputScan'];
  mcpEnforcement: OrganizationGuardrailEnforcement;
  skill: OrganizationGuardrailsPolicy['skill'];
} {
  if (!isKiloEncryptEnabled(organization.settings)) {
    return {
      inputScan: { enabled: false, scanToolResults: false },
      outputScan: { enabled: false, buffersResponses: false },
      mcpEnforcement: 'off',
      skill: { enabled: false, scanBeforeUse: false },
    };
  }
  const guardrailsSettings = organization.settings.guardrails;
  const inputGuardrail = resolveEnkryptInputGuardrail(organization.id, organization.settings);
  const outputGuardrail = resolveEnkryptOutputGuardrail(organization.id, organization.settings);
  return {
    inputScan: {
      enabled: inputGuardrail !== null,
      scanToolResults: inputGuardrail?.scanToolResults ?? false,
    },
    outputScan: {
      enabled: outputGuardrail !== null,
      buffersResponses:
        outputGuardrail !== null &&
        (outputGuardrail.status === 'invalid' || outputGuardrail.blockingDetectors.length > 0),
    },
    mcpEnforcement: guardrailsSettings?.mcp?.enforcement ?? 'off',
    skill: {
      enabled: guardrailsSettings?.skill?.enabled ?? false,
      scanBeforeUse: guardrailsSettings?.skill?.scan_before_use ?? true,
    },
  };
}

/**
 * Fills in the range from a legacy minimum and keeps a conservative minimum for
 * pre-range clients. Both keys are transitional until client rollout completes.
 */
export function normalizeGuardrailConfig(
  config: OrganizationGuardrailConfig
): OrganizationGuardrailConfig {
  if (config.kind !== 'package') return config;
  if (config.version_spec !== null && config.version_spec !== undefined) {
    return {
      ...config,
      version_spec_invalid: isValidVersionSpec(config.version_spec) ? undefined : true,
      min_version: config.min_version ?? minimumVersionForSpec(config.version_spec),
    };
  }
  const legacy = classifyLegacyMinVersion(config.min_version);
  if (legacy.kind === 'range') {
    return {
      ...config,
      version_spec: legacy.value,
      version_spec_invalid: undefined,
      min_version: config.min_version ?? minimumVersionForSpec(legacy.value),
    };
  }
  if (legacy.kind === 'invalid') {
    return { ...config, version_spec: null, version_spec_invalid: true };
  }
  return {
    ...config,
    version_spec: null,
    version_spec_invalid: undefined,
    min_version: config.min_version ?? null,
  };
}

function toAllowedMcpServer(
  row: Pick<OrganizationGuardrail, 'identity_key' | 'name' | 'description' | 'config'>
): AllowedMcpServer {
  return {
    identityKey: row.identity_key,
    name: row.name,
    description: row.description,
    config: normalizeGuardrailConfig(row.config),
  };
}

/** Enabled MCP servers only: a disabled server is not on the allow list. */
export async function listAllowedMcpServers(organizationId: string): Promise<AllowedMcpServer[]> {
  const rows = await db
    .select()
    .from(organization_guardrails)
    .where(
      and(
        eq(organization_guardrails.organization_id, organizationId),
        eq(organization_guardrails.type, 'mcp'),
        eq(organization_guardrails.status, 'enabled')
      )
    )
    .orderBy(asc(organization_guardrails.name), asc(organization_guardrails.id));
  return rows.map(toAllowedMcpServer);
}

export async function getOrganizationGuardrailsPolicy(
  organization: GuardrailSettingsOrganization
): Promise<OrganizationGuardrailsPolicy> {
  const { mcpEnforcement, inputScan, outputScan, skill } = resolveGuardrailsSettings(organization);
  return {
    inputScan,
    outputScan,
    skill,
    mcp: {
      enforcement: mcpEnforcement,
      allowedServers: mcpEnforcement === 'off' ? [] : await listAllowedMcpServers(organization.id),
    },
  };
}

export type McpConnectTargetInput =
  | { kind: 'remote'; url: string }
  | { kind: 'package'; ecosystem: 'npm' | 'pypi'; identifier: string };

export type NormalizedMcpConnectTarget = {
  target: McpTarget;
  identityKey: string;
};

/**
 * The target as the allow list knows it, or null when it can never be allowlisted: a URL that
 * is not plain https, carries credentials or placeholders, or a name that is not a package name.
 */
export function normalizeMcpConnectTarget(
  input: McpConnectTargetInput
): NormalizedMcpConnectTarget | null {
  let target: McpTarget;
  if (input.kind === 'remote') {
    const url = normalizeRemoteMcpUrl(input.url);
    if (!url.ok) return null;
    target = { kind: 'remote', url: url.value };
  } else {
    const identifier = normalizePackageIdentifier(input.ecosystem, input.identifier);
    if (!identifier.ok) return null;
    target = {
      kind: 'package',
      ecosystem: input.ecosystem,
      identifier: identifier.value,
    };
  }
  const identityKey = mcpIdentityKey(target);
  if (identityKey.length > MAX_MCP_IDENTITY_KEY_LENGTH) return null;
  return { target, identityKey };
}

export type McpConnectVersionReason = Exclude<VersionCheckResult, 'match'>;

/**
 * `reason` keeps the legacy wire value for clients that still switch on it.
 * `versionReason` carries the precise version failure for new clients.
 */
export type McpConnectVerdict =
  | { decision: 'allowed'; versionCheck?: 'server' | 'client' }
  | { decision: 'denied'; reason: 'not_allowed' | 'unsupported_target' }
  | {
      decision: 'denied';
      reason: 'below_min_version';
      versionReason: McpConnectVersionReason;
      versionCheck: 'server';
    };

/**
 * Whether the allow list admits a connect. `version` is the resolved version the
 * client is about to run, not a tag or a range. In enforce mode, a package
 * server with an allowed-versions range but no reported version is allowed with
 * `versionCheck: 'client'`, so the client enforces the range itself. Shadow mode
 * records the decision without asking the client to enforce it.
 */
export function evaluateMcpConnect(params: {
  allowedServers: readonly Pick<AllowedMcpServer, 'identityKey' | 'config'>[];
  target: NormalizedMcpConnectTarget | null;
  version?: string | null;
  mcpEnforcement: 'shadow' | 'enforce';
}): McpConnectVerdict {
  const { target } = params;
  if (!target) return { decision: 'denied', reason: 'unsupported_target' };
  const server = params.allowedServers.find(entry => entry.identityKey === target.identityKey);
  if (!server) return { decision: 'denied', reason: 'not_allowed' };
  const config = normalizeGuardrailConfig(server.config);
  if (config.kind !== 'package') {
    return { decision: 'allowed' };
  }
  if (config.version_spec_invalid) {
    return {
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'invalid_policy',
      versionCheck: 'server',
    };
  }
  if (!config.version_spec) {
    return { decision: 'allowed' };
  }
  if (!isValidVersionSpec(config.version_spec)) {
    return {
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'invalid_policy',
      versionCheck: 'server',
    };
  }
  const version = params.version?.trim() ?? '';
  if (version === '') {
    return params.mcpEnforcement === 'enforce'
      ? { decision: 'allowed', versionCheck: 'client' }
      : { decision: 'allowed' };
  }
  const result = checkVersion(version, config.version_spec, config.ecosystem);
  if (result === 'match') {
    return { decision: 'allowed', versionCheck: 'server' };
  }
  return {
    decision: 'denied',
    reason: 'below_min_version',
    versionReason: result,
    versionCheck: 'server',
  };
}
