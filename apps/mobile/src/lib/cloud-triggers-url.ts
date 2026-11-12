/**
 * The web page that manages Cloud Agent triggers (webhook and scheduled) for
 * one scope. Personal triggers live under `/cloud/triggers`; an organization's
 * live under its own cloud section. The web's `/cloud/webhooks` paths only
 * redirect here, so the app links the destination directly.
 *
 * A trailing slash on the base URL is dropped so the two halves never double up.
 */
export function getCloudTriggersUrl(
  webBaseUrl: string,
  organizationId?: string | null
): string {
  const base = webBaseUrl.endsWith('/') ? webBaseUrl.slice(0, -1) : webBaseUrl;
  return organizationId
    ? `${base}/organizations/${organizationId}/cloud/triggers`
    : `${base}/cloud/triggers`;
}
