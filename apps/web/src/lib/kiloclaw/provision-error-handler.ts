import { TRPCError } from '@trpc/server';
import { UpstreamApiError } from '@/lib/trpc/init';
import { KiloClawApiError } from './kiloclaw-internal-client';

type ProvisionErrorPayload = { message?: string; code?: string };

type ProvisionErrorPayloadReader = (err: KiloClawApiError) => ProvisionErrorPayload;

export function handleProvisionError(err: unknown, getPayload: ProvisionErrorPayloadReader): never {
  if (err instanceof KiloClawApiError && (err.statusCode === 409 || err.statusCode === 503)) {
    const { message, code } = getPayload(err);
    if (
      code === 'provision_in_progress' ||
      code === 'provision_completion_pending' ||
      code === 'instance_already_active' ||
      code === 'instance_destroyed'
    ) {
      throw new TRPCError({
        code: 'CONFLICT',
        message:
          message ??
          'An instance is already being created. Wait for setup to finish, then try again.',
        cause: new UpstreamApiError(code),
      });
    }
  }
  throw err;
}
