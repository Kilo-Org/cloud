import { AwsV4Signer } from 'aws4fetch';
import type { CustomLlmAwsBedrockCredentials } from '@kilocode/db/schema-types';

/**
 * The SigV4 service follows the IAM namespace, not the host prefix:
 * `bedrock-mantle` owns `bedrock-mantle:*` actions, while `bedrock-runtime`
 * authorizes `bedrock:*` actions.
 */
export function getBedrockSigningService(url: string): 'bedrock' | 'bedrock-mantle' {
  return new URL(url).hostname.startsWith('bedrock-mantle.') ? 'bedrock-mantle' : 'bedrock';
}

export async function signBedrockRequest({
  url,
  method,
  headers,
  body,
  credentials,
}: {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  credentials: CustomLlmAwsBedrockCredentials;
}): Promise<Headers> {
  const signed = await new AwsV4Signer({
    url,
    method,
    headers,
    body,
    accessKeyId: credentials.access_key_id,
    secretAccessKey: credentials.secret_access_key,
    region: credentials.region,
    service: getBedrockSigningService(url),
  }).sign();
  return signed.headers;
}
