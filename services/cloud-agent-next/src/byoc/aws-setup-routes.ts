import type { Context, Hono } from 'hono';
import { awsSetupRequestSchema } from '@kilocode/worker-utils/aws-onboarding-api';
import type { HonoContext } from '../hono-context.js';
import { logger } from '../logger.js';
import { readBoundedBody } from '../utils/read-bounded-body.js';
import { awsProviderSetupEnrollment, createAwsProviderSetupIntent } from './aws-setup-intent.js';
import { createAwsProviderSetupService } from './aws-setup-service.js';
import { AwsSetupError } from './aws-stack-validation.js';

/** Only the trusted web service supplies owner-bound persisted envelopes. */
export function registerAwsSetupRoutes(
  app: Hono<HonoContext>,
  requireInternalApi: (context: Context<HonoContext>) => Response | null
) {
  app.post('/internal/byoc/aws/setup', async c => {
    const unauthorized = requireInternalApi(c);
    if (unauthorized) return unauthorized;
    c.header('Cache-Control', 'no-store');
    const body = await readBoundedBody(c.req.raw, 64 * 1024);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body ?? '');
    } catch {
      return c.json({ error: 'invalid_request' }, 400);
    }
    const parsed = awsSetupRequestSchema.safeParse(decoded);
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
    const input = parsed.data;
    try {
      if (input.action === 'enrollment')
        return c.json(awsProviderSetupEnrollment(c.env, input.owner, input.provider));
      const binding = {
        owner: input.owner,
        credentialId: input.credentialId,
        generation: input.generation,
      };
      switch (input.action) {
        case 'prepare':
          return c.json(
            createAwsProviderSetupIntent(c.env, binding, input.accountId, input.provider)
          );
        case 'instructions':
          return c.json(
            await createAwsProviderSetupService(c.env, input.provider).instructions(
              binding,
              input.envelope
            )
          );
        case 'validate':
          return c.json(
            await createAwsProviderSetupService(c.env, input.provider).validate(
              binding,
              input.envelope,
              input.roleArn
            )
          );
        case 'revalidate':
          await createAwsProviderSetupService(c.env, input.provider).revalidate(
            binding,
            input.envelope,
            input.roleArn
          );
          return c.json({ verified: true });
      }
    } catch (error) {
      // AWS and encryption errors can include sensitive request data. Record and return only fixed codes.
      const code = error instanceof AwsSetupError ? error.code : 'byoc_aws_setup_unavailable';
      logger
        .withFields({
          action: input.action,
          code,
          errorName: error instanceof Error ? error.name : 'unknown',
        })
        .warn('AWS setup request failed');
      return c.json({ error: code }, 422);
    }
  });
}
