/**
 * Local Cloudflare adapter for the SESSION_INGEST service binding.
 *
 * `wrangler types` only sees `Fetcher` for service bindings. The shared RPC
 * schemas and method types live in `@kilocode/session-ingest-contracts` so the
 * producer and consumers compile against one contract while this adapter can
 * be regenerated independently from Cloudflare binding types.
 */

import type { SessionIngestRpcMethods } from '@kilocode/session-ingest-contracts';

export type * from '@kilocode/session-ingest-contracts';

export type SessionIngestBinding = Fetcher & SessionIngestRpcMethods;
