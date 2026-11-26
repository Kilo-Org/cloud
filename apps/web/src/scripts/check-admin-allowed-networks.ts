/**
 * Runs before `next build` (the `build` script): a Vercel deployment build
 * whose `ADMIN_ALLOWED_NETWORKS` is unset, empty or invalid fails here, before
 * it can be promoted. Prints no list entry; see
 * `checkAdminAllowedNetworksForDeployment`.
 */
import { checkAdminAllowedNetworksForDeployment } from '@kilocode/web-shared/lib/admin/admin-network-policy';

const check = checkAdminAllowedNetworksForDeployment(process.env);

if (check.kind === 'refused') {
  process.stderr.write(`${check.message}\n`);
  process.exit(1);
}
if (check.kind === 'valid') {
  process.stdout.write('ADMIN_ALLOWED_NETWORKS is valid for this deployment.\n');
}
