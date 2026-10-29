import type {
  OrganizationAddonEnforcement,
  OrganizationMcpAddonConfig,
  OrganizationMcpConnectDecision,
} from '@kilocode/db/schema-types';
import type { Organization, OrganizationAddon } from '@kilocode/db/schema';
import { organization_addons } from '@kilocode/db/schema';
import { resolveEnkryptInputGuardrail } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/settings';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, asc, eq } from 'drizzle-orm';
import { isKiloEncryptEnabled } from '../kilo-encrypt';
import {
  mcpIdentityKey,
  normalizePackageIdentifier,
  normalizeRemoteMcpUrl,
  type McpTarget,
} from './mcp-identity';

/** Matches the identity key length accepted by the admin audit log endpoints. */
export const MAX_MCP_IDENTITY_KEY_LENGTH = 500;

export type AllowedMcpServer = {
  identityKey: string;
  name: string;
  description: string | null;
  config: OrganizationMcpAddonConfig;
};

export type OrganizationGuardrailsPolicy = {
  inputScan: { enabled: boolean; scanToolResults: boolean };
  mcp: {
    enforcement: OrganizationAddonEnforcement;
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
  mcpEnforcement: OrganizationAddonEnforcement;
  skill: OrganizationGuardrailsPolicy['skill'];
} {
  if (!isKiloEncryptEnabled(organization.settings)) {
    return {
      inputScan: { enabled: false, scanToolResults: false },
      mcpEnforcement: 'off',
      skill: { enabled: false, scanBeforeUse: false },
    };
  }
  const addonGuardrails = organization.settings.addon_guardrails;
  const inputGuardrail = resolveEnkryptInputGuardrail(organization.id, organization.settings);
  return {
    inputScan: {
      enabled: inputGuardrail !== null,
      scanToolResults: inputGuardrail?.scanToolResults ?? false,
    },
    mcpEnforcement: addonGuardrails?.mcp?.enforcement ?? 'off',
    skill: {
      enabled: addonGuardrails?.skill?.enabled ?? false,
      scanBeforeUse: addonGuardrails?.skill?.scan_before_use ?? true,
    },
  };
}

function toAllowedMcpServer(
  row: Pick<OrganizationAddon, 'identity_key' | 'name' | 'description' | 'config'>
): AllowedMcpServer {
  return {
    identityKey: row.identity_key,
    name: row.name,
    description: row.description,
    config: row.config,
  };
}

/** Enabled MCP servers only: a disabled server is not on the allow list. */
export async function listAllowedMcpServers(organizationId: string): Promise<AllowedMcpServer[]> {
  const rows = await db
    .select()
    .from(organization_addons)
    .where(
      and(
        eq(organization_addons.organization_id, organizationId),
        eq(organization_addons.type, 'mcp'),
        eq(organization_addons.status, 'enabled')
      )
    )
    .orderBy(asc(organization_addons.name), asc(organization_addons.id));
  return rows.map(toAllowedMcpServer);
}

export async function getOrganizationGuardrailsPolicy(
  organization: GuardrailSettingsOrganization
): Promise<OrganizationGuardrailsPolicy> {
  const { mcpEnforcement, inputScan, skill } = resolveGuardrailsSettings(organization);
  return {
    inputScan,
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

function parseVersion(version: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)/i.exec(version.trim());
  return match ? match[1].split('.').map(Number) : null;
}

/**
 * Compares the leading numeric segments only, so `1.2.0rc1` counts as `1.2.0`. Returns null when
 * either version has no numeric prefix.
 */
export function isVersionAtLeast(version: string, minVersion: string): boolean | null {
  const actual = parseVersion(version);
  const minimum = parseVersion(minVersion);
  if (!actual || !minimum) return null;
  for (let index = 0; index < Math.max(actual.length, minimum.length); index++) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export type McpConnectVerdict = {
  decision: OrganizationMcpConnectDecision;
  /** Why the connect was denied; absent when allowed. */
  reason?: 'not_allowed' | 'below_min_version' | 'unsupported_target';
};

/**
 * Whether the allow list admits a connect. `version` is what the client is about to run; when
 * the client cannot tell, it leaves it out and enforces the minimum version itself. A version
 * that is given but has no numeric prefix, such as `latest`, is denied when the server has a
 * minimum.
 */
export function evaluateMcpConnect(params: {
  allowedServers: readonly Pick<AllowedMcpServer, 'identityKey' | 'config'>[];
  target: NormalizedMcpConnectTarget | null;
  version?: string | null;
}): McpConnectVerdict {
  const { target } = params;
  if (!target) return { decision: 'denied', reason: 'unsupported_target' };
  const server = params.allowedServers.find(entry => entry.identityKey === target.identityKey);
  if (!server) return { decision: 'denied', reason: 'not_allowed' };
  const { config } = server;
  if (config.kind === 'package' && config.min_version && params.version) {
    if (isVersionAtLeast(params.version, config.min_version) !== true) {
      return { decision: 'denied', reason: 'below_min_version' };
    }
  }
  return { decision: 'allowed' };
}
