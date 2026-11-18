/**
 * Total budget for one `/connect-ticket` mint: the bearer's pepper read through
 * Hyperdrive (`authenticateToken`) plus the per-ticket Durable Object mint
 * (`mintConnectionTicket`). Strictly below the client's
 * `CONTROL_PLANE_DEADLINE_MS` (15s) because the client gives up there, and
 * below the gateway's own budget: a mint that outlives either is a 504 with no
 * server-side attribution. Both hops are unbounded on their own — the Hyperdrive
 * read has no statement/connect budget and every ticket targets a fresh,
 * therefore cold, Durable Object — so they share one deadline. On expiry the
 * route answers with its retryable mint-failure response, which the client
 * already treats as a reconnect-and-retry
 * (packages/event-service/src/client.ts).
 *
 * Lives in this module instead of the Worker entry because workerd treats every
 * named export of `src/index.ts` as a Durable Object or ExportedHandler.
 * Exporting a number from the entry fails boot with
 * "Incorrect type for map entry 'TICKET_MINT_BUDGET_MS'".
 */
export const TICKET_MINT_BUDGET_MS = 8_000;
