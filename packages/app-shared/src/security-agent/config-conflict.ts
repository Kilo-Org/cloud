/**
 * Stable wire code for the Security Agent config compare-and-set refusal.
 *
 * Saving settings or toggling the agent sends the `configRevision` the client
 * last read. A write whose revision no longer matches — because another tab,
 * device, or session wrote first — is refused with `CONFLICT` and this code as
 * the rejection's cause, which the tRPC error formatter exposes to every client
 * as `data.upstreamCode`. Like the sync precondition codes, the English message
 * is the web surface's copy; a device that has to translate it maps this code
 * onto catalog copy instead.
 */
export const SECURITY_CONFIG_CONFLICT_CODE = 'security_config_conflict';
