import { z } from 'zod';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js';
import { canonicalizeValidatedInput } from '@kilocode/agent-harness/commands';
import type { ToolOutcome } from '@kilocode/agent-harness/contracts';
import { toolDefinitions, ToolRequestSchema } from '@kilocode/agent-harness/tools';
import { bytes, type RunLimits } from '../limits';
import { createMcpTransportFactory, type McpConnection } from './mcp-transport';

export type { McpConnection } from './mcp-transport';

// Only this checked vocabulary is supported. References and unknown keywords fail closed.
const unique = (values: readonly unknown[]) =>
  new Set(values.map(canonicalizeValidatedInput)).size === values.length;
const kind = z.enum(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const schema: z.ZodType<JsonSchemaType> = z.lazy(() =>
  z.strictObject({
    $schema: z.literal('https://json-schema.org/draft/2020-12/schema').optional(),
    type: z.union([kind, z.array(kind).min(1).refine(unique)]).optional(),
    properties: z.record(z.string(), schema).optional(),
    required: z.array(z.string()).refine(unique).optional(),
    additionalProperties: z.union([z.boolean(), schema]).optional(),
    items: schema.optional(),
    enum: z.array(z.json()).min(1).refine(unique).optional(),
    const: z.json().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    minLength: z.int().nonnegative().optional(),
    maxLength: z.int().nonnegative().optional(),
    minItems: z.int().nonnegative().optional(),
    maxItems: z.int().nonnegative().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    default: z.json().optional(),
  })
);
const codes = {
  unavailable_server: 'unavailable_tool',
  reauthorization_required: 'reauthorization_required',
  invalid_schema: 'invalid_output',
  unsafe_destination: 'invalid_input',
  definition_changed: 'invalid_input',
  invalid_input: 'invalid_input',
  invalid_output: 'invalid_output',
  limit_exceeded: 'limit_exceeded',
} as const;

/** Connections contain ephemeral gateway authorization, never provider credentials or stored state. */
export async function executeMcp(
  input: unknown,
  connections: readonly McpConnection[],
  budget: { deadline: number; limits: RunLimits },
  fetchImpl: typeof fetch = fetch
): Promise<ToolOutcome> {
  let reason: keyof typeof codes | undefined;
  let dispatched = false;
  const abort = new AbortController();
  const stop = (value: keyof typeof codes): never => {
    // Closing the transport on abort must not replace the original failure.
    reason ??= value;
    const error = new Error(reason);
    abort.abort(error);
    throw error;
  };
  const timeout = Math.min(budget.limits.toolAttemptMs, budget.deadline - Date.now());
  const timer = setTimeout(() => abort.abort(), Math.max(0, timeout));
  const options = {
    signal: abort.signal,
    timeout: Math.max(1, timeout),
    resetTimeoutOnProgress: false,
  };
  const transportFor = createMcpTransportFactory(
    abort.signal,
    budget.limits.httpResponseBytes,
    stop,
    fetchImpl
  );
  const validator = new CfWorkerJsonSchemaValidator();
  const checked = {
    getValidator<T>(value: JsonSchemaType) {
      try {
        if (!schema.safeParse(value).success) stop('invalid_schema');
        return validator.getValidator<T>(value);
      } catch {
        return stop('invalid_schema');
      }
    },
  };
  try {
    if (timeout <= 0) stop('limit_exceeded');
    const parsed = ToolRequestSchema.safeParse(input);
    if (!parsed.success) stop('invalid_input');
    const request = parsed.data;
    if (request.name !== 'mcp.discover' && request.name !== 'mcp.call') stop('invalid_input');
    const contract = toolDefinitions
      .filter(tool => tool.group === 'mcp')
      .find(tool => tool.name === request.name);
    if (!contract) stop('invalid_input');
    if (bytes(request.arguments) > budget.limits.toolInputBytes) stop('limit_exceeded');
    const definitions = [];
    for (const connection of connections) {
      if (request.name === 'mcp.call' && request.arguments.serverId !== connection.serverId)
        continue;
      if (
        request.name === 'mcp.call' &&
        request.arguments.configurationVersion !== connection.configurationVersion
      )
        stop('definition_changed');
      const transport = transportFor(connection);
      const client = new Client(
        { name: 'kilo-agent-harness', version: '1' },
        { jsonSchemaValidator: checked }
      );
      try {
        await client.connect(transport, options);
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, options);
          for (const tool of page.tools) {
            if (!tool.outputSchema || tool.execution?.taskSupport === 'required')
              stop('invalid_schema');
            checked.getValidator(tool.inputSchema);
            checked.getValidator(tool.outputSchema);
            const digest = await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(canonicalizeValidatedInput(tool))
            );
            const definition = {
              serverId: connection.serverId,
              configurationVersion: connection.configurationVersion,
              name: tool.name,
              definitionVersion: Array.from(new Uint8Array(digest), byte =>
                byte.toString(16).padStart(2, '0')
              ).join(''),
              inputSchema: tool.inputSchema,
              outputSchema: tool.outputSchema,
            };
            definitions.push(definition);
            if (bytes(definitions) > budget.limits.toolOutputBytes) stop('limit_exceeded');
            if (request.name !== 'mcp.call' || request.arguments.name !== tool.name) continue;
            if (request.arguments.definitionVersion !== definition.definitionVersion)
              stop('definition_changed');
            if (!checked.getValidator(tool.inputSchema)(request.arguments.arguments).valid)
              stop('invalid_input');
            dispatched = true;
            const result = await client.callTool(
              { name: tool.name, arguments: request.arguments.arguments },
              undefined,
              options
            );
            if (
              result.isError ||
              !checked.getValidator(tool.outputSchema)(result.structuredContent).valid
            )
              stop('invalid_output');
            const output = { content: result.content, structuredContent: result.structuredContent };
            if (bytes(output) > budget.limits.toolOutputBytes) stop('limit_exceeded');
            return { status: 'succeeded', output: contract.outputSchema.parse(output) };
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) stop('invalid_schema');
          if (cursor) seen.add(cursor);
        } while (cursor);
      } finally {
        await client.close();
      }
    }
    if (request.name === 'mcp.call') stop('unavailable_server');
    return { status: 'succeeded', output: contract.outputSchema.parse(definitions) };
  } catch (error) {
    if (
      (error instanceof McpError &&
        [ErrorCode.InvalidParams, ErrorCode.InvalidRequest, ErrorCode.ParseError].includes(
          error.code
        )) ||
      // SDK response parsing uses Zod Mini; the core error also covers Classic.
      error instanceof z.core.$ZodError ||
      error instanceof SyntaxError
    )
      reason ??= dispatched ? 'invalid_output' : 'invalid_schema';
    reason ??= 'unavailable_server';
    // No provider reconciliation contract exists here. A dispatched unknown effect is never replayed.
    return dispatched
      ? { status: 'outcome_unknown', reason }
      : {
          status: 'failed',
          error: {
            code: codes[reason],
            message: reason,
            retryable: reason === 'unavailable_server' || reason === 'reauthorization_required',
          },
        };
  } finally {
    clearTimeout(timer);
  }
}
