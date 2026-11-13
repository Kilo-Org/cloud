import { z } from 'zod';

/**
 * A string that carries a value: no empty id ever validates. Leaf module so a
 * schema module can use it without importing `push-data.ts`, which imports the
 * schema modules themselves.
 */
export const nonEmptyStringSchema = z.string().min(1);