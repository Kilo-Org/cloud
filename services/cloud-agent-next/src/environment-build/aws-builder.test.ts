import { describe, expect, it } from 'vitest';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ByocAwsProviderError } from '../byoc/aws-errors.js';
import { normalizeAwsProviderFailure } from '../sandbox-control/aws-failure-policy.js';
import { ProviderLifecycleError } from '../sandbox-control/provider-failure.js';
import { awsBuilderStartFailure } from './aws-builder.js';
import { BuilderRetryableError } from './builder-errors.js';

// The compute adapter normalizes every failure before the builder classifies it.
function startFailure(error: Error) {
  return awsBuilderStartFailure(normalizeAwsProviderFailure(error));
}

describe('awsBuilderStartFailure', () => {
  it.each([
    new ByocAwsProviderError('byoc_aws_not_ready'),
    new ByocAwsProviderError('byoc_aws_proxy_unavailable'),
    new ByocAwsProviderError('byoc_aws_stack_unavailable'),
    new AwsRequestError(0, 'NetworkError'),
    new AwsRequestError(429, 'ThrottlingException'),
    new AwsRequestError(503, 'ServiceUnavailable'),
  ])('keeps the build preparing after transient failure $message', error => {
    expect(startFailure(error)).toBeInstanceOf(BuilderRetryableError);
  });

  it.each([
    new ByocAwsProviderError('byoc_aws_stack_outdated'),
    new ByocAwsProviderError('byoc_aws_connection_changed'),
    new ByocAwsProviderError('byoc_aws_forbidden'),
    new AwsRequestError(403, 'AccessDenied'),
  ])('fails the start for permanent failure $message', error => {
    expect(startFailure(error)).toBeInstanceOf(ProviderLifecycleError);
  });
});
