/**
 * Stable error sentences that cross the tRPC wire verbatim from the server
 * routes to the clients: the mobile ledger
 * (`apps/mobile/src/lib/security-agent-ledger.ts`, `markerKeyFor`) maps them by
 * exact string match onto localized catalog copy. Rewording either side breaks
 * that mapping, so this module is the single source both apps import.
 *
 * The exact-match contract covers more markers than this module pins: the
 * ledger's other duplicated literals (`SECURITY_SERVICE_UNAVAILABLE_MESSAGE`,
 * the ledger marker sentences in `shared-handlers.ts`) keep their own web and
 * mobile copies. Moving them here is the same one-module-one-test pattern; this
 * module pins the two sentences the remediation work changed.
 */

/**
 * Thrown when the deployment is misconfigured: the Worker URL or the internal
 * secret is unset, or the Worker rejected the call on its internal
 * authentication (401/403). No resubmit can succeed, so the client renders the
 * service-not-configured copy.
 */
export const SECURITY_SERVICE_NOT_CONFIGURED_MESSAGE = 'Security service is not configured';

/**
 * Thrown for a definitive Worker rejection that is not an auth/config failure
 * (a policy or request-schema rejection). The Worker's error body is never
 * echoed, and the sentence never varies with the status, which is what lets
 * the mobile ledger map it onto localized copy.
 */
export const SECURITY_REMEDIATION_REJECTED_MESSAGE =
  'Security remediation service request was rejected';
