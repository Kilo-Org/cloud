import { z } from 'zod';

/**
 * Leaf module so a schema module can use it without importing `push-data.ts`,
 * which imports the schema modules themselves.
 */
export const nonEmptyStringSchema = z.string().min(1);
