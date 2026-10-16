import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import { controlPlaneRouteSpecSchema } from '../../shared/control-plane-protocol.js';
import { ROUTE_STATES, type RouteDatabase } from './routes.js';
import { buildScopeGrantView, type ScopeGrantView } from './scope-view.js';
import { routes } from './sqlite-schema.js';

const scopeMemberRouteSchema = z.object({
  sessionId: z.string(),
  state: z.enum(ROUTE_STATES),
  spec: z.object({
    kiloSessionId: controlPlaneRouteSpecSchema.shape.kiloSessionId,
    directory: controlPlaneRouteSpecSchema.shape.directory,
  }),
});

/** Read only the member identities used to authorize an adopted handle. */
export function readScopeGrantView(
  db: RouteDatabase,
  grant: SessionCredentialGrant
): ScopeGrantView {
  if (grant.members.length === 0) return buildScopeGrantView(grant, []);
  const rows = db
    .select({
      sessionId: routes.session_id,
      state: routes.state,
      spec: {
        kiloSessionId: sql<unknown>`json_extract(${routes.spec}, '$.kiloSessionId')`,
        directory: sql<unknown>`json_extract(${routes.spec}, '$.directory')`,
      },
    })
    .from(routes)
    .where(
      inArray(
        routes.session_id,
        grant.members.map(member => member.sessionId)
      )
    )
    .all();
  return buildScopeGrantView(grant, z.array(scopeMemberRouteSchema).parse(rows));
}
