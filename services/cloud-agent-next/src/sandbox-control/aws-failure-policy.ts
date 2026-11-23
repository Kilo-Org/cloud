import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ByocAwsProviderError } from '../byoc/aws-credential-resolver.js';
import { ProviderLifecycleError } from './provider-failure.js';

/** This module owns translation from AWS failures to provider failure reasons. */
export function normalizeAwsProviderFailure(error: unknown): unknown {
  if (error instanceof ByocAwsProviderError) return new ProviderLifecycleError(error.reason);
  if (error instanceof AwsRequestError) {
    if (error.status === 403 || (error.status === 400 && error.code === 'AccessDeniedException'))
      return new ProviderLifecycleError('byoc_aws_forbidden');
    if (error.status === 400 && error.code === 'ValidationException')
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
