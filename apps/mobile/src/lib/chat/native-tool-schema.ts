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

/** An argument path from the tool's own root, such as `filter` or `where.lat`. */
type OmittedArgument = { readonly argument: string; readonly reason: string };

/** A property's path below the tool's arguments, never leading with a dot. */
function joinPath(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

/** A refusal without the path it was found at; the record carries that path itself. */
function bareReason(reason: string, path: string): string {
  const prefix = `${path}: `;
  return reason.startsWith(prefix) ? reason.slice(prefix.length) : reason;
}

/**
 * One thing the on-device model cannot be given. A whole tool is left out when
 * one of its required arguments has no native form; a single argument is left
 * out when it is optional, and the tool still reaches the model without it.
 */
export type NativeOmission =
  | { readonly kind: 'tool'; readonly tool: string; readonly reason: string }
  | {
      readonly kind: 'argument';
      readonly tool: string;
      readonly argument: string;
      readonly reason: string;
    };

/** The tools the model can take, and everything left out of them. */
export type NativeToolSet = {
  readonly tools: readonly NativeTool[];
  readonly omitted: readonly NativeOmission[];
};

type Converted =
  | {
      readonly ok: true;
      readonly schema: NativeSchema;
      readonly omitted: readonly OmittedArgument[];
    }
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

/** A refusal's words, naming the argument path when the tool's own root is not the site. */
function atPath(path: string, reason: string): string {
  return path === '' ? reason : `${path}: ${reason}`;
}

function convertObject(node: SchemaNode, path: string): Converted {
  const properties = node.properties ?? {};
  // A map with free keys cannot be generated: the schema must name every key.
  if (
    Object.keys(properties).length === 0 &&
    node.additionalProperties !== undefined &&
    node.additionalProperties !== false
  ) {
    return { ok: false, reason: atPath(path, 'an object with free keys') };
  }
  const required = new Set(node.required);
  const converted: NativeProperty[] = [];
  const omitted: OmittedArgument[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const argument = joinPath(path, name);
    const property = convert(value, argument);
    if (property.ok) {
      // A nested object's omissions are relative to it, so this level names them.
      omitted.push(
        ...property.omitted.map(one => ({ ...one, argument: joinPath(name, one.argument) }))
      );
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
      omitted.push({ argument: name, reason: bareReason(property.reason, argument) });
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
      ? ({ ok: false, reason: atPath(path, 'an array without one item schema') } as const)
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
    return { ok: false, reason: atPath(path, 'not a schema') };
  }
  const unwrapped = withoutNull(parsed.data);
  if (!unwrapped.ok) {
    return { ok: false, reason: atPath(path, unwrapped.reason) };
  }
  const { node } = unwrapped;
  const keyword = UNSUPPORTED_KEYWORDS.find(name => name in node);
  if (keyword !== undefined) {
    return { ok: false, reason: atPath(path, keyword) };
  }
  if (node.enum !== undefined) {
    const choices = StringChoices.safeParse(node.enum);
    return !choices.success || (node.type !== undefined && node.type !== 'string')
      ? { ok: false, reason: atPath(path, 'an enum that is not a list of strings') }
      : {
          ok: true,
          schema: { type: 'string', ...descriptionOf(node), choices: choices.data },
          omitted: [],
        };
  }
  const type = node.type ?? (node.properties === undefined ? undefined : 'object');
  if (type === undefined) {
    return { ok: false, reason: atPath(path, 'no supported type') };
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
      return { ok: false, reason: atPath(path, 'no supported type') };
    }
  }
}

/** The arguments schema of one tool, or why Foundation Models cannot take it. */
export function nativeSchemaOf(tool: ToolDefinition): Converted {
  const converted = convert(tool.parameters, '');
  if (converted.ok && converted.schema.type !== 'object') {
    return { ok: false, reason: 'arguments are not an object' };
  }
  return converted;
}

/** One tool's conversion, and the record of everything it left out. */
type ConvertedTool = {
  readonly tool: NativeTool | undefined;
  readonly omitted: readonly NativeOmission[];
};

function conversionOf(tool: ToolDefinition): ConvertedTool {
  const converted = nativeSchemaOf(tool);
  if (!converted.ok) {
    return {
      tool: undefined,
      omitted: [{ kind: 'tool', tool: tool.name, reason: converted.reason }],
    };
  }
  return {
    tool: {
      name: tool.name,
      description: tool.description,
      parameters: JSON.stringify(converted.schema),
    },
    omitted: converted.omitted.map(one => ({
      kind: 'argument',
      tool: tool.name,
      argument: one.argument,
      reason: one.reason,
    })),
  };
}

/** The words one omission is logged with, and the reason a screen shows. */
function noteOf(omission: NativeOmission): string {
  return omission.kind === 'tool'
    ? `tool left out: ${omission.tool}: ${omission.reason}`
    : `optional argument left out: ${omission.tool}.${omission.argument}: ${omission.reason}`;
}

/**
 * The tools Foundation Models can take, and everything left out of them.
 *
 * A tool whose schema it cannot express is left out, so the model never sees a
 * call it could not write, and an optional argument that has no native form is
 * left out of a tool that still reaches the model. Every omission is logged
 * here and also answered to the caller: a screen names the tools the person
 * enabled that this model cannot run, which no log line can say.
 */
export function nativeTools(tools: readonly ToolDefinition[]): NativeToolSet {
  const accepted: NativeTool[] = [];
  const omitted: NativeOmission[] = [];
  for (const tool of tools) {
    const conversion = conversionOf(tool);
    for (const omission of conversion.omitted) {
      // eslint-disable-next-line no-console -- a diagnostic copy of what the answer already carries
      console.warn(`[native-model] ${noteOf(omission)}`);
    }
    if (conversion.tool !== undefined) {
      accepted.push(conversion.tool);
    }
    omitted.push(...conversion.omitted);
  }
  return { tools: accepted, omitted };
}

/**
 * The same conversion without the log, for a screen that names the tools this
 * model cannot run. It costs one schema walk per tool, so a caller reads it
 * when the offered tools change rather than on every request.
 */
export function omittedTools(tools: readonly ToolDefinition[]): readonly NativeOmission[] {
  return tools.flatMap(tool => conversionOf(tool).omitted);
}
