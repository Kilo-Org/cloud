import { MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH } from '@kilocode/db/schema-types';
import { organization_mcp_connect_events } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { Organization } from '@kilocode/db/schema';
import {
  evaluateMcpConnect,
  listAllowedMcpServers,
  normalizeMcpConnectTarget,
  resolveGuardrailsSettings,
  type McpConnectTargetInput,
  type McpConnectVerdict,
} from './guardrails-policy';

export const MCP_CONNECT_CLIENTS = ['cli', 'cloud_agent', 'vscode', 'jetbrains', 'other'] as const;
export type McpConnectClient = (typeof MCP_CONNECT_CLIENTS)[number];

export type McpConnectionReport = {
  target: McpConnectTargetInput;
  serverName?: string | null;
  version?: string | null;
};

export type McpConnectionResult = McpConnectVerdict & {
  identityKey: string | null;
  /** `block` only when the organization enforces its allow list and the connect is denied. */
  action: 'allow' | 'block';
  /** Whether the connect was written to the audit log. */
  recorded: boolean;
};

function cleanServerName(name: string | null | undefined): string | null {
  return name?.trim().slice(0, MAX_ORGANIZATION_GUARDRAIL_NAME_LENGTH).trim() || null;
}

/**
 * Decides each reported connect against the organization's allow list and writes it to the audit
 * log. Nothing is recorded while MCP guardrails are off. A connect that can never be allowlisted
 * (plain http, credentials in the URL, an invalid package name) is denied but not recorded,
 * because the audit log and its approve action only know allowlistable servers and the target
 * could carry credentials.
 */
export async function evaluateAndRecordMcpConnections(params: {
  organization: Pick<Organization, 'id' | 'settings'>;
  kiloUserId: string;
  client: McpConnectClient;
  connections: readonly McpConnectionReport[];
}): Promise<{
  enforcement: 'off' | 'shadow' | 'enforce';
  results: McpConnectionResult[];
}> {
  const { organization, kiloUserId, client, connections } = params;
  const { mcpEnforcement } = resolveGuardrailsSettings(organization);
  if (mcpEnforcement === 'off') {
    return {
      enforcement: mcpEnforcement,
      results: connections.map(() => ({
        decision: 'allowed',
        identityKey: null,
        action: 'allow',
        recorded: false,
      })),
    };
  }

  const allowedServers = await listAllowedMcpServers(organization.id);
  const evaluated = connections.map(connection => {
    const target = normalizeMcpConnectTarget(connection.target);
    return {
      target,
      serverName: cleanServerName(connection.serverName),
      verdict: evaluateMcpConnect({
        allowedServers,
        target,
        version: connection.version,
      }),
    };
  });

  const rows = evaluated.flatMap(({ target, serverName, verdict }) =>
    target
      ? [
          {
            organization_id: organization.id,
            kilo_user_id: kiloUserId,
            client,
            decision: verdict.decision,
            identity_key: target.identityKey,
            target: target.target,
            server_name: serverName,
          },
        ]
      : []
  );
  if (rows.length > 0) await db.insert(organization_mcp_connect_events).values(rows);

  return {
    enforcement: mcpEnforcement,
    results: evaluated.map(({ target, verdict }) => ({
      ...verdict,
      identityKey: target?.identityKey ?? null,
      action: verdict.decision === 'denied' && mcpEnforcement === 'enforce' ? 'block' : 'allow',
      recorded: target !== null,
    })),
  };
}
