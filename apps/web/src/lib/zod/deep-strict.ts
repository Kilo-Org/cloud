import { z } from 'zod';

/**
 * Returns a copy of `schema` in which every nested `z.object(...)` is made
 * `strict` — extra keys at any depth cause validation to fail.
 *
 * Zod's built-in `.strict()` only applies to a single level, so it is
 * insufficient for validating the entire shape of a user-supplied JSON
 * document (e.g. an admin editing a custom-LLM definition).
 *
 * Handled wrappers: object, optional, nullable, array, record, union
 * (covers `z.discriminatedUnion`, which shares `type: 'union'`), and
 * intersection. These include the wrappers used by `CustomLlmDefinitionSchema`
 * today.
 *
 * Recognised leaves (string, number, boolean, date, enum, literal,
 * template_literal, bigint, symbol, null, undefined, void, never, any,
 * unknown, nan, file) are returned unchanged.
 *
 * Any other Zod type (tuple, map, set, nonoptional, default, prefault,
 * readonly, catch, pipe, lazy, transform, promise, function,
 * custom, success) throws, so a future schema change that introduces a new
 * wrapper surfaces here instead of silently skipping deep-strict and
 * allowing unknown keys through.
 */
const LEAF_TYPES = new Set<string>([
  'string',
  'number',
  'int',
  'boolean',
  'bigint',
  'symbol',
  'null',
  'undefined',
  'void',
  'never',
  'any',
  'unknown',
  'date',
  'nan',
  'file',
  'enum',
  'literal',
  'template_literal',
]);

type ZodShape = Record<string, z.ZodTypeAny>;

function mergeIntersectionShapes(left: ZodShape, right: ZodShape): ZodShape {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = Object.hasOwn(merged, key) ? z.intersection(merged[key], value) : value;
  }
  return merged;
}

function getIntersectionObjectShape(schema: z.ZodTypeAny): ZodShape | null {
  if (schema.type === 'object') {
    return (schema as z.ZodObject).shape;
  }
  if (schema.type !== 'intersection') {
    return null;
  }

  const intersection = schema as z.ZodIntersection;
  const left = getIntersectionObjectShape(intersection.def.left as z.ZodTypeAny);
  const right = getIntersectionObjectShape(intersection.def.right as z.ZodTypeAny);
  return left && right ? mergeIntersectionShapes(left, right) : null;
}

export function deepStrict<T extends z.ZodType>(schema: T): z.ZodType<z.infer<T>> {
  const anySchema = schema as unknown as z.ZodTypeAny;
  switch (anySchema.type) {
    case 'object': {
      const obj = anySchema as z.ZodObject;
      const newShape: Record<string, z.ZodTypeAny> = {};
      for (const [key, value] of Object.entries(obj.shape)) {
        newShape[key] = deepStrict(value as z.ZodTypeAny);
      }
      return z.strictObject(newShape) as unknown as z.ZodType<z.infer<T>>;
    }
    case 'optional': {
      const inner = (anySchema as z.ZodOptional<z.ZodTypeAny>).unwrap();
      return deepStrict(inner).optional() as unknown as z.ZodType<z.infer<T>>;
    }
    case 'nullable': {
      const inner = (anySchema as z.ZodNullable<z.ZodTypeAny>).unwrap();
      return deepStrict(inner).nullable() as unknown as z.ZodType<z.infer<T>>;
    }
    case 'array': {
      const element = (anySchema as z.ZodArray<z.ZodTypeAny>).element;
      return z.array(deepStrict(element)) as unknown as z.ZodType<z.infer<T>>;
    }
    case 'record': {
      const rec = anySchema as z.ZodRecord;
      return z.record(
        rec.keyType as z.core.$ZodRecordKey,
        deepStrict(rec.valueType as z.ZodTypeAny)
      ) as unknown as z.ZodType<z.infer<T>>;
    }
    case 'union': {
      const options = (anySchema as z.ZodUnion).options as readonly z.ZodTypeAny[];
      const strictOptions = options.map(o => deepStrict(o));
      return z.union(
        strictOptions as unknown as readonly [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]
      ) as unknown as z.ZodType<z.infer<T>>;
    }
    case 'intersection': {
      const objectShape = getIntersectionObjectShape(anySchema);
      if (objectShape) {
        return deepStrict(z.object(objectShape)) as unknown as z.ZodType<z.infer<T>>;
      }

      const intersection = anySchema as z.ZodIntersection;
      return z.intersection(
        deepStrict(intersection.def.left as z.ZodTypeAny),
        deepStrict(intersection.def.right as z.ZodTypeAny)
      ) as unknown as z.ZodType<z.infer<T>>;
    }
    default: {
      const type = anySchema.type;
      if (LEAF_TYPES.has(type)) {
        return schema as unknown as z.ZodType<z.infer<T>>;
      }
      throw new Error(
        `deepStrict: unsupported Zod type '${type}'. Extend the helper to handle this wrapper.`
      );
    }
  }
}
