export class ByocAwsProviderError extends Error {
  constructor(
    readonly reason:
      | 'byoc_credential_missing'
      | 'byoc_aws_not_ready'
      | 'byoc_aws_forbidden'
      | 'byoc_aws_stack_outdated'
      | 'byoc_aws_stack_unavailable'
      | 'byoc_aws_proxy_unavailable'
      | 'byoc_aws_proxy_expired'
      | 'byoc_aws_connection_changed'
  ) {
    super(reason);
    this.name = 'ByocAwsProviderError';
  }
}
