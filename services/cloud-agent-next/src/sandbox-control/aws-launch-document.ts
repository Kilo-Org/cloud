import type { AwsObjectStore } from '../agent-sandbox/aws/object-store.js';
import { CONTROL_WRAPPER_LOG_PATH } from './container-paths.js';
import { ProviderCreationError, type ProviderStartup } from './provider.js';

export type AwsLaunchEnvelope = { url: string; sha256: string; deadlineAt: number; proxy?: string };

/** Compute requests carry the S3 download capability and, when configured, an allocation-scoped proxy credential.
 * The full startup environment remains in the launch document. See docs/aws-byoc.md for the access boundary.
 */
export async function uploadAwsLaunchDocument(input: {
  objects: AwsObjectStore;
  startup: ProviderStartup;
  providerRef: string;
  intentId: string;
  deadlineAt: number;
}): Promise<AwsLaunchEnvelope> {
  if (input.startup.command.argv.length === 0 || input.startup.command.argv.length > 64)
    throw new ProviderCreationError('invalid_configuration');
  const env: Record<string, string> = {
    ...input.startup.env,
    PROVIDER_INSTANCE_ID: input.providerRef,
    WRAPPER_LOG_PATH: CONTROL_WRAPPER_LOG_PATH,
  };
  const document = JSON.stringify({
    format: 1,
    deadlineAt: input.deadlineAt,
    argv: input.startup.command.argv,
    env,
  });
  const bytes = new TextEncoder().encode(document);
  if (bytes.byteLength > 262_144) throw new ProviderCreationError('invalid_configuration');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(digest), byte =>
    byte.toString(16).padStart(2, '0')
  ).join('');
  const key = `kilo/launch/${input.intentId}.json`;
  const envelope = {
    url: await input.objects.downloadUrl(key, 600),
    sha256,
    deadlineAt: input.deadlineAt,
    ...(env.HTTPS_PROXY ? { proxy: env.HTTPS_PROXY } : {}),
  };
  if (new TextEncoder().encode(JSON.stringify(envelope)).byteLength > 16_384)
    throw new ProviderCreationError('invalid_configuration');
  await input.objects.putLaunch(key, document);
  return envelope;
}
