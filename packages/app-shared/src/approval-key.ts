import { z } from 'zod';

/**
 * One approval binding: SHA-256 hex of an approval target, else null. The key
 * grants no authority — an answer revalidates the exact current request — but
 * every payload that carries one enforces the same representation.
 */
export const approvalKeySchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
