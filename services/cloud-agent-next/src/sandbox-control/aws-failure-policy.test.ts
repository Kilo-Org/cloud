import { describe, expect, it } from 'vitest';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { ByocAwsProviderError } from '../byoc/aws-credential-resolver.js';
import { normalizeAwsProviderFailure } from './aws-failure-policy.js';
import { providerFailureReason } from './provider-failure.js';

describe('AWS provider failure policy', () => {
  it.each([
    new AwsRequestError(403, 'RequestRejected'),
    new AwsRequestError(400, 'AccessDeniedException'),
    new ByocAwsProviderError('byoc_aws_forbidden'),
  ])('preserves permanent access denial: %s', error => {
    expect(providerFailureReason(normalizeAwsProviderFailure(error))).toBe('byoc_aws_forbidden');
  });
  it.each([
    new AwsRequestError(0, 'TransportError'),
    new AwsRequestError(429, 'ThrottlingException'),
    new AwsRequestError(503, 'InternalServerException'),
    new Error('deadline'),
  ])('keeps transient failure retryable: %s', error => {
    expect(normalizeAwsProviderFailure(error)).toBe(error);
    expect(providerFailureReason(error)).toBeUndefined();
  });
});
