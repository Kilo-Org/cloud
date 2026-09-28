import { Duration, Effect } from 'effect';
import { type JsonSchema, type Tool, type ToolCall, ToolFailure } from '../../core/tool.js';
import {
  remoteMcpClient,
  type RemoteMcpClient,
  type RemoteMcpClientDeps,
  type RemoteMcpTool,
} from './client.js';
import {
  callableName,
  explain,
  mcpToolName,
  type RemoteMcpError,
  type RemoteMcpServer,
} from './server.js';

/**
 * A remote MCP server's tools, as tools this harness can offer a model.
 *
 * What a server offers is discovered at the moment it is asked, so a tool list
 * is a value and not a constant: the model is told about a server's tools as
 * they stand when the session is wired, and a call reads the server again.
 *
 * Nothing a remote tool does fails the conversation. A server that refuses the
 * token, has been taken down, or answers an error all come back as a failed
 * tool result, which is what the model reads before it decides what to do. That
 * is what keeps a chat usable when a server it can reach stops answering.
 *
 * The model is not the only party who needs to know. A call that did not reach
 * the server is also handed to the caller through `onCallFailure`, because a
 * failed tool result reaches the model and never a person's screen — so a
 * caller that draws the connection says what happened rather than leaving a
 * green dot over a server that answers nothing.
 */

/** A model's arguments, read as the JSON object every tool of this shape takes. */
const isFields = (held: unknown): held is Readonly<Record<string, unknown>> =>
  typeof held === 'object' && held !== null && !Array.isArray(held);

const isNames = (held: unknown): held is readonly string[] =>
  Array.isArray(held) && held.every(name => typeof name === 'string');

/**
 * The harness schema for a remote tool, built from the server's own.
 *
 * A tool whose schema is not an object takes arguments the model cannot write,
 * so it is skipped rather than offered. The client library's own `ToolSchema`
 * refuses such a tool before this runs — it rejects the whole `tools/list`
 * answer, not the one entry — so the guard is reached only by a caller driving
 * the client another way, and it is here to keep the definition honest rather
 * than to catch a live case.
 *
 * Everything else is copied across as it stands: the properties, what is
 * required, and whether more is allowed.
 */
const parametersOf = (schema: Readonly<Record<string, unknown>>): JsonSchema | undefined => {
  if (schema['type'] !== 'object') {
    return undefined;
  }
  const { properties, required, additionalProperties } = schema;
  return {
    type: 'object',
    properties: isFields(properties) ? properties : {},
    ...(isNames(required) ? { required } : {}),
    ...(typeof additionalProperties === 'boolean' ? { additionalProperties } : {}),
  };
};

/** The model's arguments, or a failure saying why they could not be read. */
const argumentsOf = (
  tool: RemoteMcpTool,
  call: ToolCall
): Effect.Effect<Readonly<Record<string, unknown>>, ToolFailure> =>
  Effect.try({
    try: (): unknown => JSON.parse(call.arguments),
    catch: cause =>
      new ToolFailure({ cause: `The arguments for ${tool.name} are not JSON: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap(held =>
      isFields(held)
        ? Effect.succeed(held)
        : Effect.fail(
            new ToolFailure({ cause: `The arguments for ${tool.name} are not a JSON object.` })
          )
    )
  );

/**
 * One remote tool.
 *
 * `inlineFor` is 15 seconds: a call to somebody else's server is the case the
 * deadline exists for, and a slow one is backgrounded by the session rather
 * than holding the send open. The model is told the call is still running and
 * the result arrives in a round of its own. That needs the call's own deadline
 * to end later than `inlineFor`, which is why a call's default deadline is 60
 * seconds (`defaultCallTimeoutMs`).
 */
const toolFor = (
  server: RemoteMcpServer,
  client: RemoteMcpClient,
  tool: RemoteMcpTool
): readonly Tool[] => {
  const parameters = parametersOf(tool.inputSchema);
  if (parameters === undefined || !callableName(server.id) || !callableName(tool.name)) {
    return [];
  }
  return [
    {
      definition: {
        name: mcpToolName(server, tool.name),
        description: tool.description ?? `Call ${tool.name} on ${server.name}.`,
        parameters,
      },
      inlineFor: Duration.seconds(15),
      run: (call: ToolCall) =>
        Effect.gen(function* () {
          const args = yield* argumentsOf(tool, call);
          return yield* client
            .call(tool.name, args)
            .pipe(
              Effect.mapError(error =>
                error instanceof ToolFailure ? error : new ToolFailure({ cause: explain(error) })
              )
            );
        }),
    },
  ];
};

/**
 * The tools one server offers.
 *
 * The client is built once and each tool closes over it, so a caller who offers
 * a server's tools gets one place where its credential is refreshed and one
 * place where its failures are classified.
 */
const remoteMcpTools = (
  server: RemoteMcpServer,
  deps: RemoteMcpClientDeps
): Effect.Effect<readonly Tool[], RemoteMcpError> => {
  const client = remoteMcpClient(server, deps);
  return client.tools.pipe(
    Effect.map(tools => tools.flatMap(tool => toolFor(server, client, tool)))
  );
};

export { remoteMcpTools };
