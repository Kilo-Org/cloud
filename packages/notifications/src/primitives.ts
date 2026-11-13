import { z } from 'zod';

/**
 * Shared field primitive: every identifier-like string this package validates
 * rejects the empty string. It lives in its own module because both
 * `notification-events.ts` and `push-data.ts` need it, and `push-data.ts`
 * imports the event schemas from `notification-events.ts`; declaring it in
 * either of those files would make the import circular.
 */
export const nonEmptyStringSchema = z.string().min(1);
