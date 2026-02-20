/**
 * Request/response schemas for the dispatcher API.
 * These can be imported by clients for type-safe API calls.
 */

import { z } from 'zod';

// --- Shared schemas ---

export const workerNameSchema = z.string().regex(/^[a-zA-Z0-9-_]{1,64}$/);

export const returnPathSchema = z
  .string()
  .refine(path => path.startsWith('/') && !path.startsWith('//'), {
    message: 'Return path must be relative and not protocol-relative',
  })
  .catch('/');

export const successResponseSchema = z.object({
  success: z.literal(true),
});

// --- API route schemas (api.ts) ---

export const setPasswordRequestSchema = z.object({
  password: z.string().min(1),
});

export const slugParamSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
  .min(3)
  .max(63);

export const setSlugMappingRequestSchema = z.object({
  slug: slugParamSchema,
});

// --- Banner response schemas ---

export const getBannerResponseSchema = z.object({
  enabled: z.boolean(),
});

export const setPasswordResponseSchema = z.object({
  success: z.literal(true),
  passwordSetAt: z.number(),
});

export const getPasswordResponseSchema = z.discriminatedUnion('protected', [
  z.object({
    protected: z.literal(true),
    passwordSetAt: z.number(),
  }),
  z.object({
    protected: z.literal(false),
  }),
]);

export const apiErrorResponseSchema = z.object({
  error: z.string(),
});

// --- Auth route schemas (auth.ts) ---

export const authFormSchema = z.object({
  password: z.string().min(1),
  return: returnPathSchema.optional().default('/'),
});

// --- Inferred types for client use ---

export type WorkerName = z.infer<typeof workerNameSchema>;
export type ReturnPath = z.infer<typeof returnPathSchema>;
export type SuccessResponse = z.infer<typeof successResponseSchema>;

export type SetPasswordRequest = z.infer<typeof setPasswordRequestSchema>;
export type SetPasswordResponse = z.infer<typeof setPasswordResponseSchema>;
export type GetPasswordResponse = z.infer<typeof getPasswordResponseSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

export type AuthFormData = z.infer<typeof authFormSchema>;

export type SetSlugMappingRequest = z.infer<typeof setSlugMappingRequestSchema>;

export type GetBannerResponse = z.infer<typeof getBannerResponseSchema>;
