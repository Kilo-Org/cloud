/**
 * Prints the Vercel Firewall custom rule that denies admin paths to addresses
 * outside `ADMIN_ALLOWED_NETWORKS`, validated with the same parser the in-app
 * guard uses. Stdout carries only the rule JSON; errors go to stderr with a
 * non-zero exit.
 *
 *   ADMIN_ALLOWED_NETWORKS=<list> pnpm --filter web -s script src/scripts/admin-network-firewall-rule.ts
 *   vercel firewall rules add --json "$(...)"
 */
import {
  adminNetworkFirewallRule,
  parseAdminAllowedNetworks,
} from '@kilocode/web-shared/lib/admin/admin-network-policy';

const parsed = parseAdminAllowedNetworks(process.env.ADMIN_ALLOWED_NETWORKS);

if (parsed.kind === 'empty') {
  process.stderr.write('ADMIN_ALLOWED_NETWORKS is unset or empty.\n');
  process.exit(1);
}
if (parsed.kind === 'invalid') {
  process.stderr.write(`ADMIN_ALLOWED_NETWORKS is invalid: ${parsed.message}\n`);
  process.exit(1);
}

process.stdout.write(`${JSON.stringify(adminNetworkFirewallRule(parsed.entries))}\n`);
