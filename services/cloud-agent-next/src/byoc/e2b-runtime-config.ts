import { z } from 'zod';
import { E2BProviderError } from './e2b-errors.js';

const releaseSchema = z
  .object({
    templateId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    templateReference: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9-]{0,62}\/[a-z0-9][a-z0-9-]{0,62}:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      ),
    runtimeBuildId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
  })
  .strict();

export type E2BRelease = z.infer<typeof releaseSchema>;
export type E2BRuntimeEnv = {
  E2B_SANDBOX_TEMPLATE?: string;
  E2B_SANDBOX_TEMPLATE_ID?: string;
  E2B_SANDBOX_RUNTIME_BUILD_ID?: string;
};

export function parseE2BReleaseConfig(env: E2BRuntimeEnv): E2BRelease {
  const parsed = releaseSchema.safeParse({
    templateId: env.E2B_SANDBOX_TEMPLATE_ID?.trim(),
    templateReference: env.E2B_SANDBOX_TEMPLATE?.trim(),
    runtimeBuildId: env.E2B_SANDBOX_RUNTIME_BUILD_ID?.trim(),
  });
  if (!parsed.success) throw new E2BProviderError('byoc_e2b_template_unavailable');
  return parsed.data;
}
