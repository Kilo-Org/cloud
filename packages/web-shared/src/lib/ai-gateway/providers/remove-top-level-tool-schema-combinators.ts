import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

const COMBINATOR_KEYWORDS = ['allOf', 'anyOf', 'oneOf'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function addMissingProperties(schema: Record<string, unknown>, branchProperties: unknown) {
  if (!isRecord(branchProperties)) {
    return;
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [name, propertySchema] of Object.entries(branchProperties)) {
    if (!(name in properties)) {
      properties[name] = propertySchema;
    }
  }
  schema.properties = properties;
}

function addRequired(schema: Record<string, unknown>, branchRequired: unknown) {
  if (!Array.isArray(branchRequired)) {
    return;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  schema.required = [...new Set([...required, ...branchRequired])];
}

/**
 * Removes `allOf`, `anyOf` and `oneOf` from the root of a tool schema, which
 * loosens validation rather than rejecting the tool. Properties that only a
 * branch declares are kept as optional properties so `additionalProperties:
 * false` does not forbid them, and `allOf` branches keep their `required`
 * entries since every branch applies. Mutates the schema in place.
 */
export function removeTopLevelSchemaCombinators(schema: unknown): void {
  if (!isRecord(schema)) {
    return;
  }
  let removed = false;
  for (const keyword of COMBINATOR_KEYWORDS) {
    const branches = schema[keyword];
    if (branches === undefined) {
      continue;
    }
    delete schema[keyword];
    removed = true;
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      if (!isRecord(branch)) {
        continue;
      }
      addMissingProperties(schema, branch.properties);
      if (keyword === 'allOf') {
        addRequired(schema, branch.required);
      }
    }
  }
  if (removed && schema.type === undefined) {
    schema.type = 'object';
  }
}

export function removeTopLevelToolSchemaCombinators(request: GatewayRequest): void {
  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') removeTopLevelSchemaCombinators(tool.function.parameters);
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type === 'function') removeTopLevelSchemaCombinators(tool.parameters);
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if ('input_schema' in tool) removeTopLevelSchemaCombinators(tool.input_schema);
      }
      break;
  }
}
