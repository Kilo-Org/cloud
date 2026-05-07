import { SignatureV4 } from '@aws-sdk/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import type { CustomLlmAwsBedrock } from '@kilocode/db';
import type { SignedRequest, SignRequestArgs } from '@/lib/ai-gateway/providers/types';

export function makeBedrockSignRequest(
  credentials: CustomLlmAwsBedrock,
  modelId: string
): (args: SignRequestArgs) => Promise<SignedRequest> {
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credentials.access_key_id,
      secretAccessKey: credentials.secret_access_key,
    },
    region: credentials.region,
    service: 'bedrock',
    sha256: Sha256,
  });

  const hostname = `bedrock-runtime.${credentials.region}.amazonaws.com`;

  return async ({ method, body }) => {
    const isStreaming = parseStreamFlag(body);
    const path = `/model/${encodeURIComponent(modelId)}/${
      isStreaming ? 'invoke-with-response-stream' : 'invoke'
    }`;

    const signed = await signer.sign({
      method,
      hostname,
      path,
      protocol: 'https:',
      headers: {
        'Content-Type': 'application/json',
        host: hostname,
      },
      body,
    });

    return {
      url: `https://${hostname}${signed.path ?? path}`,
      headers: signed.headers,
    };
  };
}

function parseStreamFlag(body: string): boolean {
  try {
    const parsed = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' && parsed.stream === true;
  } catch {
    return false;
  }
}
