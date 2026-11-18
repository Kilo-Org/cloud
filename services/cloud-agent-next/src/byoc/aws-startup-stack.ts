import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import type { AwsStack } from '@kilocode/worker-utils/aws-cloudformation';
import type { AwsByocConfiguration } from '@kilocode/worker-utils/aws-byoc';
import { ByocAwsProviderError } from './aws-credential-resolver.js';
import { assertAwsAllocationStack, AwsSetupError } from './aws-stack-validation.js';

/** Safe reads may retry. Known version or resource mismatches fail before any compute request. */
export async function validateAwsStartupStack(input: {
  configuration: AwsByocConfiguration;
  read: (signal: AbortSignal) => Promise<AwsStack>;
  pause?: (ms: number) => Promise<void>;
}): Promise<void> {
  const pause = input.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let stack: AwsStack | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      stack = await input.read(AbortSignal.timeout(5000));
      if (stack.status.endsWith('_IN_PROGRESS')) {
        if (attempt === 2) throw new ByocAwsProviderError('byoc_aws_stack_unavailable');
        await pause([1000, 2000][attempt]);
        continue;
      }
      break;
    } catch (error) {
      if (error instanceof ByocAwsProviderError) throw error;
      if (error instanceof AwsRequestError && error.status === 403)
        throw new ByocAwsProviderError('byoc_aws_forbidden');
      const transient =
        error instanceof AwsRequestError &&
        (error.status === 0 || error.status === 429 || error.status >= 500);
      if (!transient) throw new ByocAwsProviderError('byoc_aws_not_ready');
      if (attempt === 2) throw new ByocAwsProviderError('byoc_aws_stack_unavailable');
      await pause([100, 250][attempt]);
    }
  }
  if (!stack) throw new ByocAwsProviderError('byoc_aws_not_ready');
  try {
    assertAwsAllocationStack(stack, input.configuration);
  } catch (error) {
    if (error instanceof AwsSetupError) {
      if (
        error.code === 'byoc_aws_stack_outdated' ||
        error.code === 'byoc_aws_proxy_protocol_unsupported'
      )
        throw new ByocAwsProviderError('byoc_aws_stack_outdated');
      if (error.code === 'byoc_aws_stack_mismatch')
        throw new ByocAwsProviderError('byoc_aws_connection_changed');
    }
    throw new ByocAwsProviderError('byoc_aws_not_ready');
  }
}
