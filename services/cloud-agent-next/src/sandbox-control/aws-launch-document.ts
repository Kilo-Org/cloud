import type { AwsEc2HostLaunch } from '@kilocode/worker-utils/aws-egress';
import { CONTROL_WRAPPER_LOG_PATH } from './container-paths.js';
import { ProviderCreationError, type ProviderStartup } from './provider.js';

export function renderAwsLaunchDocument(input: {
  startup: ProviderStartup;
  providerRef: string;
  deadlineAt: number;
  host?: AwsEc2HostLaunch;
}): string {
  if (input.startup.command.argv.length === 0 || input.startup.command.argv.length > 64)
    throw new ProviderCreationError('invalid_configuration');
  const document = JSON.stringify({
    format: 1,
    deadlineAt: input.deadlineAt,
    argv: input.startup.command.argv,
    env: {
      ...input.startup.env,
      PROVIDER_INSTANCE_ID: input.providerRef,
      WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
    },
    ...(input.host === undefined ? {} : { host: input.host }),
  });
  if (new TextEncoder().encode(document).byteLength > 262_144)
    throw new ProviderCreationError('invalid_configuration');
  return document;
}
