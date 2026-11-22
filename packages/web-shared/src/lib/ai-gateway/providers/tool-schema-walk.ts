import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

type ToolSchemaVisit = (name: string, schema: unknown, strict: boolean | null | undefined) => void;

/**
 * Calls `visit` with the name, schema and `strict` flag of every tool of `request` that declares a
 * schema, in all three request kinds. Tools of another type, such as a server tool, are skipped.
 */
export function forEachToolSchema(request: GatewayRequest, visit: ToolSchemaVisit): void {
  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') {
          visit(tool.function.name, tool.function.parameters, tool.function.strict);
        }
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') visit(tool.name, tool.parameters, tool.strict);
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if ('input_schema' in tool) visit(tool.name, tool.input_schema, tool.strict);
      }
      break;
  }
}

/**
 * Appends the constraints `constraints` returns for a tool schema to that tool's description,
 * which is the field the tool's own API kind declares for it.
 */
export function appendToolSchemaConstraints(
  request: GatewayRequest,
  constraints: (
    name: string,
    schema: unknown,
    strict: boolean | null | undefined
  ) => string | undefined
): void {
  const append = (description: string | null | undefined, text: string) =>
    description ? `${description}\n\n${text}` : text;

  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        const fn = tool.function;
        const text = constraints(fn.name, fn.parameters, fn.strict);
        if (text) fn.description = append(fn.description, text);
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        const text = constraints(tool.name, tool.parameters, tool.strict);
        if (text) tool.description = append(tool.description, text);
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if (!('input_schema' in tool)) continue;
        const text = constraints(tool.name, tool.input_schema, tool.strict);
        if (text) tool.description = append(tool.description, text);
      }
      break;
  }
}

/**
 * Clear the `strict` flag of every tool whose schema `rewritten` reports it changed, in the way the
 * tool's own API kind expresses an absent flag. `rewritten` mutates the schema and returns whether
 * it changed it; it runs for every tool, including one whose `strict` flag is absent, and only the
 * flag clear is gated on the flag.
 */
export function clearRewrittenToolSchemaStrict(
  request: GatewayRequest,
  rewritten: (name: string, schema: unknown, strict: boolean | null | undefined) => boolean
): void {
  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        const fn = tool.function;
        if (rewritten(fn.name, fn.parameters, fn.strict) && fn.strict) delete fn.strict;
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        if (rewritten(tool.name, tool.parameters, tool.strict) && tool.strict) tool.strict = false;
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if (!('input_schema' in tool)) continue;
        if (rewritten(tool.name, tool.input_schema, tool.strict) && tool.strict) {
          delete tool.strict;
        }
      }
      break;
  }
}
