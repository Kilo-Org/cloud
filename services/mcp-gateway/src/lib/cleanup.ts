import {
  mcp_gateway_authorization_codes,
  mcp_gateway_authorization_requests,
  mcp_gateway_audit_events,
  mcp_gateway_pending_provider_authorizations,
  mcp_gateway_rate_limit_windows,
  mcp_gateway_refresh_tokens,
} from '@kilocode/db/schema';
import { and, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { MCPGatewayEnv } from '../types';
import { getRuntimeDb } from '../db/runtime-repository';

export async function runCleanup(env: MCPGatewayEnv['Bindings']) {
  const db = getRuntimeDb(env);
  await db
    .delete(mcp_gateway_authorization_requests)
    .where(lt(mcp_gateway_authorization_requests.expires_at, sql`NOW()`));
  await db
    .delete(mcp_gateway_authorization_codes)
    .where(lt(mcp_gateway_authorization_codes.expires_at, sql`NOW()`));
  await db
    .delete(mcp_gateway_pending_provider_authorizations)
    .where(lt(mcp_gateway_pending_provider_authorizations.expires_at, sql`NOW()`));
  await db
    .delete(mcp_gateway_refresh_tokens)
    .where(
      and(
        or(
          isNotNull(mcp_gateway_refresh_tokens.consumed_at),
          isNotNull(mcp_gateway_refresh_tokens.revoked_at)
        ),
        lt(mcp_gateway_refresh_tokens.created_at, sql`NOW() - INTERVAL '60 days'`)
      )
    );
  await db
    .delete(mcp_gateway_rate_limit_windows)
    .where(
      lt(mcp_gateway_rate_limit_windows.window_started_at, sql`NOW() - INTERVAL '10 minutes'`)
    );
  await db
    .delete(mcp_gateway_audit_events)
    .where(lt(mcp_gateway_audit_events.created_at, sql`NOW() - INTERVAL '60 days'`));
}
