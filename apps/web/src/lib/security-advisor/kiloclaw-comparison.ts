import type { KiloClawComparisonEntry } from './schemas';

/**
 * Static lookup table mapping audit finding areas to KiloClaw's managed security posture.
 *
 * Used in two contexts:
 * - **OpenClaw users:** "How KiloClaw handles this" — sales comparison showing what
 *   they'd get by switching to KiloClaw.
 * - **KiloClaw users:** "KiloClaw default" — divergence warning showing that their
 *   instance has drifted from the secure-by-default configuration.
 *
 * To add coverage for a new checkId, add it to the `matchCheckIds` array of the
 * relevant entry — no new code needed.
 */
export const KILOCLAW_COMPARISON: KiloClawComparisonEntry[] = [
  {
    area: 'config_permissions',
    summary: 'Config files are restricted to owner-only access (mode 600)',
    detail:
      'KiloClaw VMs are provisioned with strict file permissions. The OpenClaw config file ' +
      'and all credential material are owned by a dedicated service user with mode 600. ' +
      'No other process on the VM can read secrets from the config.',
    matchCheckIds: ['fs.config.perms_world_readable', 'fs.config.perms_group_readable'],
  },
  {
    area: 'authentication',
    summary: 'JWT + pepper auth on every request with automatic rotation',
    detail:
      'KiloClaw enforces JWT-based authentication on every API request. Tokens are scoped ' +
      'per-user, short-lived for session use, and long-lived tokens (device auth) are peppered ' +
      'and stored encrypted. Token validation happens at the gateway layer before any request ' +
      'reaches the OpenClaw process.',
    matchCheckIds: [
      'auth.no_authentication',
      'auth.weak_token',
      'auth.token_exposed',
      'auth.no_pepper',
    ],
  },
  {
    area: 'gateway_exposure',
    summary: 'Gateway bound to localhost; external access via authenticated reverse proxy only',
    detail:
      'KiloClaw instances run behind an authenticated reverse proxy. The OpenClaw gateway ' +
      'binds to 127.0.0.1 and is never directly exposed to the internet. All external traffic ' +
      'is routed through the platform load balancer with TLS termination, rate limiting, and ' +
      'DDoS protection.',
    matchCheckIds: [
      'net.gateway_exposed',
      'net.gateway_open_to_world',
      'net.no_tls',
      'summary.attack_surface',
    ],
  },
  {
    area: 'secret_storage',
    summary: 'Secrets injected via encrypted environment variables, never stored on disk',
    detail:
      'API keys and credentials on KiloClaw are injected as encrypted environment variables ' +
      'at boot time, sourced from a secrets manager. They are never written to the config file ' +
      'or any on-disk location. The OpenClaw process reads them from memory only.',
    matchCheckIds: [
      'secrets.plaintext_in_config',
      'secrets.api_key_exposed',
      'secrets.env_file_readable',
    ],
  },
  {
    area: 'network_allowlist',
    summary: 'Strict IP allow-listing with default-deny firewall rules',
    detail:
      'KiloClaw VMs use a default-deny firewall. Only explicitly allowed IP ranges can reach ' +
      'the gateway. The allow list is managed per-organization through the KiloClaw dashboard ' +
      'and enforced at the network layer, not just the application layer.',
    matchCheckIds: ['net.no_allowlist', 'net.allowlist_too_broad', 'net.open_to_all'],
  },
  {
    area: 'update_policy',
    summary: 'Automatic security patches with zero-downtime rolling updates',
    detail:
      'KiloClaw instances receive automatic security patches within 24 hours of release. ' +
      'Updates are applied via rolling deployment with health checks — no user intervention ' +
      'required, no downtime. Critical CVEs trigger immediate patching outside the normal cycle.',
    matchCheckIds: [
      'version.outdated',
      'version.unsupported',
      'version.cve_known',
      'plugins.outdated',
    ],
  },
  {
    area: 'audit_logging',
    summary: 'Full request audit trail with 90-day retention',
    detail:
      'Every API request to a KiloClaw instance is logged with timestamp, user ID, action, ' +
      'and result. Logs are shipped to centralized storage with 90-day retention and are ' +
      'available in the KiloClaw dashboard for review. Anomalous patterns trigger alerts.',
    matchCheckIds: ['audit.no_logging', 'audit.logs_world_readable', 'audit.no_retention'],
  },
  {
    area: 'mcp_security',
    summary: 'MCP servers vetted and sandboxed with network isolation',
    detail:
      'MCP servers on KiloClaw run in isolated containers with restricted network access. ' +
      'Each server is vetted before inclusion in the marketplace. Servers cannot access the ' +
      'host filesystem, other containers, or the OpenClaw config. Communication is limited ' +
      'to the stdio transport with the parent OpenClaw process.',
    matchCheckIds: [
      'mcp.unvetted_server',
      'mcp.server_network_access',
      'mcp.server_fs_access',
      'mcp.no_sandbox',
    ],
  },
];

/**
 * Find the comparison entry that matches a given checkId.
 * Returns null if no comparison entry covers this checkId.
 */
export function findComparisonForCheckId(checkId: string): KiloClawComparisonEntry | null {
  return KILOCLAW_COMPARISON.find(entry => entry.matchCheckIds.includes(checkId)) ?? null;
}
