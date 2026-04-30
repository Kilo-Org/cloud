import { z } from 'zod';

/**
 * Returns a copy of `schema` in which every nested `z.object(...)` is made
 * `strict` — extra keys at any depth cause validation to fail.
 *
 * Zod's built-in `.strict()` only applies to a single level, so it is
 * insufficient for validating the entire shape of a user-supplied JSON
 * document (e.g. an admin editing a custom-LLM definition).
 *
 * Only the wrappers used by `CustomLlmDefinitionSchema` are handled
 * (object, optional, nullable, array, record, union). Leaf schemas
 * (string, number, boolean, enum, literal, ...) are returned unchanged.
 */
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
    default:
      return schema as unknown as z.ZodType<z.infer<T>>;
  }
}
