import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';

const COMBINATORS = [
  ['allOf', 'all of'],
  ['anyOf', 'at least one of'],
  ['oneOf', 'exactly one of'],
] as const;

type Combinator = (typeof COMBINATORS)[number][0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredNames(branch: unknown): string[] {
  if (!isRecord(branch) || !Array.isArray(branch.required)) {
    return [];
  }
  return branch.required.filter(name => typeof name === 'string');
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

function addRequired(schema: Record<string, unknown>, names: string[]) {
  if (names.length === 0) {
    return;
  }
  const required: unknown[] = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  schema.required = [...new Set([...required, ...names])];
}

/**
 * Every `allOf` branch applies, so all of their required properties are
 * required. Only one `anyOf`/`oneOf` branch has to match, so a property is only
 * required when every branch requires it.
 */
function requiredByCombinator(keyword: Combinator, branches: unknown[]): string[] {
  const names = branches.map(requiredNames);
  if (keyword === 'allOf') {
    return names.flat();
  }
  const [first = [], ...rest] = names;
  return first.filter(name => rest.every(branchNames => branchNames.includes(name)));
}

/**
 * Removes `allOf`, `anyOf` and `oneOf` from the root of a tool schema, which
 * loosens validation rather than rejecting the tool. Properties that only a
 * branch declares are kept so `additionalProperties: false` does not forbid
 * them, and properties every applicable branch requires stay required.
 * Mutates the schema in place and returns the removed constraints as text for
 * the model, or undefined when there are none.
 */
export function removeTopLevelSchemaCombinators(schema: unknown): string | undefined {
  if (!isRecord(schema)) {
    return undefined;
  }
  let removed = false;
  const constraints: string[] = [];
  for (const [keyword, description] of COMBINATORS) {
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
      if (isRecord(branch)) {
        addMissingProperties(schema, branch.properties);
      }
    }
    addRequired(schema, requiredByCombinator(keyword, branches));
    constraints.push(
      `The input must also match ${description} these JSON schemas: ${JSON.stringify(branches)}`
    );
  }
  if (removed && schema.type === undefined) {
    schema.type = 'object';
  }
  return constraints.length > 0 ? constraints.join('\n') : undefined;
}

function appendConstraints(description: string | null | undefined, constraints: string): string {
  return description ? `${description}\n\n${constraints}` : constraints;
}

/**
 * The flattened schema accepts every input the original accepted, so a tool's
 * `strict` flag is kept: strict mode still enforces the remaining schema, and
 * the removed constraints move to the tool description.
 */
export function removeTopLevelToolSchemaCombinators(request: GatewayRequest): void {
  const changedTools: { name: string; combinators: Combinator[]; strict: boolean }[] = [];
  const rewrite = (name: string, schema: unknown, strict: boolean | null | undefined) => {
    const combinators = isRecord(schema)
      ? COMBINATORS.flatMap(([keyword]) => (schema[keyword] === undefined ? [] : [keyword]))
      : [];
    if (combinators.length > 0) {
      changedTools.push({ name, combinators, strict: strict === true });
    }
    return removeTopLevelSchemaCombinators(schema);
  };

  switch (request.kind) {
    case 'chat_completions':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        const { name, parameters, strict } = tool.function;
        const constraints = rewrite(name, parameters, strict);
        if (constraints) {
          tool.function.description = appendConstraints(tool.function.description, constraints);
        }
      }
      break;
    case 'responses':
      for (const tool of request.body.tools ?? []) {
        if (tool.type !== 'function') continue;
        const constraints = rewrite(tool.name, tool.parameters, tool.strict);
        if (constraints) {
          tool.description = appendConstraints(tool.description, constraints);
        }
      }
      break;
    case 'messages':
      for (const tool of request.body.tools ?? []) {
        if (!('input_schema' in tool)) continue;
        const constraints = rewrite(tool.name, tool.input_schema, tool.strict);
        if (constraints) {
          tool.description = appendConstraints(tool.description, constraints);
        }
      }
      break;
  }

  if (changedTools.length > 0) {
    warnExceptInTest(
      '[removeTopLevelToolSchemaCombinators] removed top-level tool schema combinators',
      {
        model: request.body.model,
        requestKind: request.kind,
        tools: changedTools,
      }
    );
  }
}
