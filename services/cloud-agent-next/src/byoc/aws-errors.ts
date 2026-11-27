import { AWS_SETUP_ERRORS, type AwsSetupErrorCode } from '@kilocode/worker-utils/aws-onboarding';

export class ByocAwsProviderError extends Error {
  constructor(
    readonly reason:
      | 'byoc_credential_missing'
      | 'byoc_aws_not_ready'
      | 'byoc_aws_forbidden'
      | 'byoc_aws_stack_outdated'
      | 'byoc_aws_stack_unavailable'
      | 'byoc_aws_connection_changed'
  ) {
    super(reason);
    this.name = 'ByocAwsProviderError';
  }
}

export class AwsSetupError extends Error {
  constructor(readonly code: AwsSetupErrorCode) {
    super(AWS_SETUP_ERRORS[code]);
    this.name = 'AwsSetupError';
  }
}
