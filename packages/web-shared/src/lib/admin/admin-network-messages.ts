/**
 * Stable codes and copy for an admin network refusal. Shared by the server
 * guards and the browser step-up dialog, so it imports nothing server-only.
 */
export const ADMIN_NETWORK_DENIED_CODE = 'ADMIN_NETWORK_DENIED';
export const ADMIN_NETWORK_NOT_CONFIGURED_CODE = 'ADMIN_NETWORK_NOT_CONFIGURED';

export const ADMIN_NETWORK_DENIED_MESSAGE =
  'Admin access is limited to the corporate network. Connect to Cloudflare WARP, then try again.';
export const ADMIN_NETWORK_NOT_CONFIGURED_MESSAGE =
  'Admin access is unavailable because the admin network allowlist is not configured for this deployment.';
