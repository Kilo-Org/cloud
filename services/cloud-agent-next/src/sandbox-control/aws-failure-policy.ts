import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ByocAwsProviderError } from '../byoc/aws-credential-resolver.js';
import { AwsEcsRunRejectedError } from '../agent-sandbox/aws/ecs-client.js';
import { ProviderLifecycleError } from './provider-failure.js';

/** This module owns translation from AWS failures to provider failure reasons. */
export function normalizeAwsProviderFailure(error: unknown): unknown {
  if (error instanceof ByocAwsProviderError) return new ProviderLifecycleError(error.reason);
  if (error instanceof AwsRequestError) {
    if (error.status === 0 && error.code === 'TaskIdentityMismatch')
      return new ProviderLifecycleError('provider_identity_mismatch');
    if (error.status === 0 && error.code === 'TaskDefinitionMismatch')
      return new ProviderLifecycleError('invalid_configuration');
    if (error.status === 403 || (error.status === 400 && error.code === 'AccessDeniedException'))
      return new ProviderLifecycleError('byoc_aws_forbidden');
    if (error.status === 400 && error.code === 'ValidationException')
      return new ProviderLifecycleError('invalid_configuration');
    // On ECS reads and StopTask, this code means the task is unknown, not that configuration is invalid.
    if (error instanceof AwsEcsRunRejectedError && error.code === 'InvalidParameterException')
      return new ProviderLifecycleError('invalid_configuration');
  }
  return error;
}

export function withAwsFailurePolicy<Args extends unknown[], Result>(
  operation: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try {
      return await operation(...args);
    } catch (error) {
      throw normalizeAwsProviderFailure(error);
    }
  };
}
