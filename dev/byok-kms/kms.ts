import { AwsClient } from 'aws4fetch';

export type KmsContext = Record<string, string>;

export class KmsRequestError extends Error {
  constructor(
    target: string,
    readonly status: number
  ) {
    super(`KMS ${target} failed with ${status}`);
  }
}

export type DataKey = {
  plaintext: Buffer;
  ciphertextBlob: string;
  keyId: string;
};

export type KmsApi = {
  generateDataKey(args: { keyId: string; context: KmsContext }): Promise<DataKey>;
  decrypt(args: { ciphertextBlob: string; keyId: string; context: KmsContext }): Promise<Buffer>;
};

type KmsConfig = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetch?: typeof fetch;
};

export function createKmsApi(config: KmsConfig): KmsApi {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    region: config.region,
    service: 'kms',
  });
  const doFetch = config.fetch ?? fetch;

  async function call(target: string, body: unknown): Promise<Record<string, unknown>> {
    const signed = await client.sign(config.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `TrentService.${target}`,
      },
      body: JSON.stringify(body),
    });
    const response = await doFetch(signed);
    if (!response.ok) {
      throw new KmsRequestError(target, response.status);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  return {
    async generateDataKey({ keyId, context }) {
      const result = await call('GenerateDataKey', {
        KeyId: keyId,
        KeySpec: 'AES_256',
        EncryptionContext: context,
      });
      if (
        typeof result.Plaintext !== 'string' ||
        typeof result.CiphertextBlob !== 'string' ||
        typeof result.KeyId !== 'string'
      ) {
        throw new Error('KMS GenerateDataKey returned an unexpected response');
      }
      return {
        plaintext: Buffer.from(result.Plaintext, 'base64'),
        ciphertextBlob: result.CiphertextBlob,
        keyId: result.KeyId,
      };
    },
    async decrypt({ ciphertextBlob, keyId, context }) {
      const result = await call('Decrypt', {
        CiphertextBlob: ciphertextBlob,
        KeyId: keyId,
        EncryptionContext: context,
      });
      if (typeof result.Plaintext !== 'string') {
        throw new Error('KMS Decrypt returned an unexpected response');
      }
      return Buffer.from(result.Plaintext, 'base64');
    },
  };
}
