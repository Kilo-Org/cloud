import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import * as z from 'zod';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import {
  evaluateAndRecordMcpConnections,
  MCP_CONNECT_CLIENTS,
  type McpConnectionResult,
} from '@/lib/organizations/addons/mcp-connections';

export const MAX_MCP_CONNECTIONS_PER_REQUEST = 50;

const ConnectionSchema = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('remote'), url: z.string().max(2048) }),
    z.object({
      kind: z.literal('package'),
      ecosystem: z.enum(['npm', 'pypi']),
      identifier: z.string().max(300),
    }),
  ]),
  serverName: z.string().max(200).nullish(),
  version: z.string().max(64).nullish(),
});

const BodySchema = z.object({
  client: z.enum(MCP_CONNECT_CLIENTS),
  connections: z.array(ConnectionSchema).min(1).max(MAX_MCP_CONNECTIONS_PER_REQUEST),
});

type ResponseBody = {
  enforcement: 'off' | 'shadow' | 'enforce';
  results: McpConnectionResult[];
};

/**
 * Reports the MCP servers a client is connecting to. The server decides each one against the
 * organization's allow list, writes it to the audit log, and answers with the decision and
 * whether the client must block it. `results` is in the order of `connections`.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse<ResponseBody | { error: string }>> {
  const organizationId = (await params).id;
  const { success, data, nextResponse } = await getAuthorizedOrgContext(organizationId);
  if (!success) {
    return nextResponse;
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const body = BodySchema.safeParse(json);
  if (!body.success) {
    return NextResponse.json({ error: z.prettifyError(body.error) }, { status: 400 });
  }

  return NextResponse.json(
    await evaluateAndRecordMcpConnections({
      organization: data.organization,
      kiloUserId: data.user.id,
      client: body.data.client,
      connections: body.data.connections,
    })
  );
}
