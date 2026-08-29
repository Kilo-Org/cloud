import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { type ToolOutcome } from '@kilocode/agent-harness/contracts';
import { ToolRequestSchema, toolDefinitions } from '@kilocode/agent-harness/tools';
import { rootRouter } from '@/routers/root-router';
import { authorizeHarnessCapability, harnessInputDigest } from './authorization';

const Id = z.uuid().transform(value => value.toLowerCase());
const definitions = toolDefinitions.filter(tool => tool.name.startsWith('kilo.sessions.'));
const Invocation = z.strictObject({
  conversationId: Id,
  operationId: Id,
  name: z.enum(definitions.map(tool => tool.name)),
  arguments: z.unknown(),
});
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 64 * 1024)
    throw new TRPCError({ code: 'PAYLOAD_TOO_LARGE' });
  return value;
}

export function createHarnessCloudAgentContext(token: string, input: unknown) {
  const invocation = Invocation.parse(input);
  const request = ToolRequestSchema.parse({
    name: invocation.name,
    arguments: invocation.arguments,
  });
  bounded(request);
  const definition = definitions.find(tool => tool.name === request.name);
  if (!definition) throw new TRPCError({ code: 'BAD_REQUEST' });
  const scope = {
    audience: 'agent-harness:operations',
    conversationId: invocation.conversationId,
    operation: request.name,
    definitionVersion: definition.version,
    inputDigest: harnessInputDigest(request.arguments),
    dispatchId: invocation.operationId,
    target: { kind: 'backend' } as const,
  };
  // Stable, schema-valid message identity; include the immutable input and conversation in its digest.
  const messageId = `msg_${harnessInputDigest(scope).slice(0, 26)}`;
  const fresh = async () => {
    const { ctx, authority } = await authorizeHarnessCapability(token, scope);
    return { caller: rootRouter.createCaller(ctx), authority };
  };
  const owned = async (sessionId: string) => {
    const current = await fresh();
    const session = await current.caller.cliSessionsV2.get({ session_id: sessionId });
    if (session.organization_id !== current.authority.organizationId)
      throw new TRPCError({ code: 'FORBIDDEN' });
    return { ...current, session };
  };
  const history = async (sessionId: string) => {
    await owned(sessionId);
    const { caller } = await fresh();
    // One bounded recent page, never an unbounded snapshot or attachment download.
    const page = await caller.cliSessionsV2.getSessionMessagesPage({
      session_id: sessionId,
      limit: 20,
      bounded: true,
    });
    if (page.kiloSessionId !== sessionId) throw new TRPCError({ code: 'FORBIDDEN' });
    if (!page.history) return [];
    if ('kind' in page.history) {
      const codes = {
        retryable_failure: 'SERVICE_UNAVAILABLE',
        too_large: 'PAYLOAD_TOO_LARGE',
        invalid_data: 'UNPROCESSABLE_CONTENT',
      } as const;
      throw new TRPCError({ code: codes[page.history.kind] });
    }
    if (page.history.messages.some(message => message.info.sessionID !== sessionId))
      throw new TRPCError({ code: 'FORBIDDEN' });
    return page.history.messages.slice(0, 20);
  };
  const cloudSession = async (sessionId: string) => {
    const current = await owned(sessionId);
    const cloudAgentSessionId = current.session.cloud_agent_session_id;
    if (!cloudAgentSessionId) throw new TRPCError({ code: 'PRECONDITION_FAILED' });
    return { ...current, cloudAgentSessionId };
  };
  const sessionState = async (
    { caller, authority }: Awaited<ReturnType<typeof fresh>>,
    cloudAgentSessionId: string
  ) => {
    const organizationId = authority.organizationId;
    const state =
      organizationId === null
        ? await caller.cloudAgentNext.getSession({ cloudAgentSessionId })
        : await caller.organizations.cloudAgentNext.getSession({
            cloudAgentSessionId,
            organizationId,
          });
    if (
      state.sessionId !== cloudAgentSessionId ||
      state.userId !== authority.userId ||
      (state.orgId ?? null) !== organizationId
    )
      throw new TRPCError({ code: 'FORBIDDEN' });
    return state;
  };
  const succeeded = (output: unknown): ToolOutcome => ({
    status: 'succeeded',
    output: bounded(definition.outputSchema.parse(output)),
  });
  const search = async () => {
    if (request.name !== 'kilo.sessions.search') throw new TRPCError({ code: 'BAD_REQUEST' });
    const { caller, authority } = await fresh();
    const page = await caller.cliSessionsV2.search({
      search_string: request.arguments.query,
      organizationId: authority.organizationId,
      limit: 20,
      offset: 0,
    });
    return succeeded(
      page.results.slice(0, 20).map(session => ({
        sessionId: session.session_id,
        title: session.title || session.session_id,
      }))
    );
  };
  const attachContext = async () => {
    if (request.name !== 'kilo.sessions.attach') throw new TRPCError({ code: 'BAD_REQUEST' });
    const sessionId = request.arguments.sessionId;
    const messages = await history(sessionId);
    return succeeded({
      sessionId,
      untrusted: true,
      messages: messages.map(message => ({
        role: message.info.role,
        content: message.parts
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n'),
      })),
    });
  };
  const progress = async () => {
    if (request.name !== 'kilo.sessions.progress') throw new TRPCError({ code: 'BAD_REQUEST' });
    const sessionId = request.arguments.sessionId;
    const linked = await cloudSession(sessionId);
    const state = await sessionState(await fresh(), linked.cloudAgentSessionId);
    return succeeded({
      sessionId,
      status:
        state.execution?.status ?? (state.preparedAt && !state.initiatedAt ? 'prepared' : 'idle'),
    });
  };
  return {
    invocation,
    request,
    messageId,
    fresh,
    owned,
    history,
    cloudSession,
    sessionState,
    succeeded,
    search,
    attachContext,
    progress,
  };
}
