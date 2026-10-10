import { type ToolDefinition } from '@kilocode/harness-sdk';
import { z } from 'zod';

/**
 * The part of JSON Schema that Apple's `DynamicGenerationSchema` can express.
 * The native module builds the Foundation Models schema from this tree, one
 * node for one node, so every rule about what fits is decided here.
 */
type NativeSchema =
  | { readonly type: 'string'; readonly description?: string; readonly choices?: readonly string[] }
  | { readonly type: 'integer' | 'number' | 'boolean'; readonly description?: string }
  | {
      readonly type: 'array';
      readonly description?: string;
      readonly items: NativeSchema;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly type: 'object';
      readonly description?: string;
      readonly properties: readonly NativeProperty[];
    };

type NativeProperty = {
  readonly name: string;
  readonly description?: string;
  readonly optional: boolean;
  readonly schema: NativeSchema;
};

/** A tool as the native module receives it. `parameters` is a `NativeSchema` as JSON text. */
export type NativeTool = {
  readonly name: string;
  readonly description: string;
  readonly parameters: string;
};

type Converted =
  | { readonly ok: true; readonly schema: NativeSchema; readonly omitted: readonly string[] }
  | { readonly ok: false; readonly reason: string };

/** The keywords read here. Any other keyword stays on the node, so it can be refused by name. */
const SchemaNode = z.looseObject({
  type: z.union([z.string(), z.array(z.string())]).optional(),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
  items: z.unknown().optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.array(z.string()).optional(),
  additionalProperties: z.unknown().optional(),
  minItems: z.int().nonnegative().optional(),
  maxItems: z.int().nonnegative().optional(),
  anyOf: z.array(z.unknown()).optional(),
  oneOf: z.array(z.unknown()).optional(),
});
type SchemaNode = z.infer<typeof SchemaNode>;

/** Keywords that need an intersection, a reference, or a condition. None has a native form. */
const UNSUPPORTED_KEYWORDS = [
  'allOf',
  'not',
  '$ref',
  'const',
  'if',
  'patternProperties',
  'prefixItems',
] as const;

const StringChoices = z.array(z.string()).min(1);

function descriptionOf(node: SchemaNode): { description?: string } {
  return node.description === undefined || node.description === ''
    ? {}
    : { description: node.description };
}

/**
 * A nullable value is the value itself: Foundation Models writes no null, and
 * a value always satisfies a nullable schema. Both spellings are common in
 * schemas made from Zod: a type list with `null`, and a union with `null`.
 */
function withoutNull(
  node: SchemaNode
):
  | { readonly ok: true; readonly node: SchemaNode }
  | { readonly ok: false; readonly reason: string } {
  if (Array.isArray(node.type)) {
    const types = node.type.filter(type => type !== 'null');
    return types.length === 1
      ? { ok: true, node: { ...node, type: types[0] } }
      : { ok: false, reason: 'a type list' };
  }
  let keyword: 'anyOf' | 'oneOf' | undefined = undefined;
  if (node.anyOf !== undefined) {
    keyword = 'anyOf';
  } else if (node.oneOf !== undefined) {
    keyword = 'oneOf';
  }
  if (keyword === undefined) {
    return { ok: true, node };
  }
  const kept = (node[keyword] ?? []).filter(
    choice => SchemaNode.safeParse(choice).data?.type !== 'null'
  );
  const only = SchemaNode.safeParse(kept[0]);
  if (kept.length !== 1 || !only.success) {
    return { ok: false, reason: keyword };
  }
  const { [keyword]: _union, ...rest } = node;
  return withoutNull({ ...rest, ...only.data, ...descriptionOf(rest) });
}

function convertObject(node: SchemaNode, path: string): Converted {
  const properties = node.properties ?? {};
  // A map with free keys cannot be generated: the schema must name every key.
  if (
    Object.keys(properties).length === 0 &&
    node.additionalProperties !== undefined &&
    node.additionalProperties !== false
  ) {
    return { ok: false, reason: `${path}: an object with free keys` };
  }
  const required = new Set(node.required);
  const converted: NativeProperty[] = [];
  const omitted: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const property = convert(value, `${path}.${name}`);
    if (property.ok) {
      omitted.push(...property.omitted);
      const described = SchemaNode.safeParse(value);
      converted.push({
        name,
        ...(described.success ? descriptionOf(described.data) : {}),
        optional: !required.has(name),
        schema: property.schema,
      });
    } else if (required.has(name)) {
      return property;
    } else {
      // The model cannot fill an optional key it is not shown; the tool still works without it.
      omitted.push(property.reason);
    }
  }
  return {
    ok: true,
    schema: { type: 'object', ...descriptionOf(node), properties: converted },
    omitted,
  };
}

function convertArray(node: SchemaNode, path: string): Converted {
  // A tuple (a list of item schemas) has no native form, and neither has a list of anything.
  const items =
    node.items === undefined || Array.isArray(node.items)
      ? ({ ok: false, reason: `${path}: an array without one item schema` } as const)
      : convert(node.items, `${path}[]`);
  if (!items.ok) {
    return items;
  }
  return {
    ok: true,
    schema: {
      type: 'array',
      ...descriptionOf(node),
      items: items.schema,
      ...(node.minItems === undefined ? {} : { minItems: node.minItems }),
      ...(node.maxItems === undefined ? {} : { maxItems: node.maxItems }),
    },
    omitted: items.omitted,
  };
}

function convert(value: unknown, path: string): Converted {
  const parsed = SchemaNode.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: `${path}: not a schema` };
  }
  const unwrapped = withoutNull(parsed.data);
  if (!unwrapped.ok) {
    return { ok: false, reason: `${path}: ${unwrapped.reason}` };
  }
  const { node } = unwrapped;
  const keyword = UNSUPPORTED_KEYWORDS.find(name => name in node);
  if (keyword !== undefined) {
    return { ok: false, reason: `${path}: ${keyword}` };
  }
  if (node.enum !== undefined) {
    const choices = StringChoices.safeParse(node.enum);
    return !choices.success || (node.type !== undefined && node.type !== 'string')
      ? { ok: false, reason: `${path}: an enum that is not a list of strings` }
      : {
          ok: true,
          schema: { type: 'string', ...descriptionOf(node), choices: choices.data },
          omitted: [],
        };
  }
  const type = node.type ?? (node.properties === undefined ? undefined : 'object');
  if (type === undefined) {
    return { ok: false, reason: `${path}: no supported type` };
  }
  switch (type) {
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean': {
      return { ok: true, schema: { type, ...descriptionOf(node) }, omitted: [] };
    }
    case 'array': {
      return convertArray(node, path);
    }
    case 'object': {
      return convertObject(node, path);
    }
    default: {
      return { ok: false, reason: `${path}: no supported type` };
    }
  }
}

/** The arguments schema of one tool, or why Foundation Models cannot take it. */
export function nativeSchemaOf(tool: ToolDefinition): Converted {
  const converted = convert(tool.parameters, tool.name);
  if (converted.ok && converted.schema.type !== 'object') {
    return { ok: false, reason: `${tool.name}: arguments are not an object` };
  }
  return converted;
}

/**
 * The tools Foundation Models can take. A tool whose schema it cannot express
 * is left out and logged, so the model never sees a call it could not write.
 */
export function nativeTools(tools: readonly ToolDefinition[]): NativeTool[] {
  return tools.flatMap(tool => {
    const converted = nativeSchemaOf(tool);
    const notes = converted.ok
      ? converted.omitted.map(reason => `optional argument left out: ${reason}`)
      : [`tool left out: ${converted.reason}`];
    for (const note of notes) {
      // eslint-disable-next-line no-console -- a tool the model never sees has no UI to report it
      console.warn(`[native-model] ${note}`);
    }
    return converted.ok
      ? [
          {
            name: tool.name,
            description: tool.description,
            parameters: JSON.stringify(converted.schema),
          },
        ]
      : [];
  });
}
