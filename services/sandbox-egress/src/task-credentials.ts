import { get } from 'node:http';
import { z } from 'zod';
import { awsCredentialsSchema, type AwsCredentials } from '@kilocode/worker-utils/aws-client';

const metadataSchema = z.object({
  AccessKeyId: awsCredentialsSchema.shape.accessKeyId,
  SecretAccessKey: awsCredentialsSchema.shape.secretAccessKey,
  Token: awsCredentialsSchema.shape.sessionToken.unwrap(),
  Expiration: z.iso.datetime(),
});

export class TaskCredentialsError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid' | 'expiring') {
    super(`AWS proxy task credentials ${code}`);
    this.name = 'TaskCredentialsError';
  }
}

function fetchTaskMetadata(path: string, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = get(
      { hostname: '169.254.170.2', port: 80, path, signal, agent: false, maxHeaderSize: 8192 },
      response => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new TaskCredentialsError('unavailable'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 32_768) {
            request.destroy();
            reject(new TaskCredentialsError('invalid'));
          } else chunks.push(chunk);
        });
        response.once('error', () => reject(new TaskCredentialsError('unavailable')));
        response.once('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
          } catch {
            reject(new TaskCredentialsError('invalid'));
          }
        });
      }
    );
    request.once('error', () => reject(new TaskCredentialsError('unavailable')));
  });
}

/** Only the trusted ECS task endpoint can supply this proxy's prefix-scoped role. */
export async function readProxyTaskCredentials(
  relativeUri: string | undefined,
  fetchMetadata = fetchTaskMetadata,
  now = Date.now()
): Promise<AwsCredentials> {
  if (!relativeUri || !/^\/v2\/credentials\/[a-f0-9-]{36}$/.test(relativeUri))
    throw new TaskCredentialsError('invalid');
  let raw: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      raw = await fetchMetadata(relativeUri, AbortSignal.timeout(3_000));
      break;
    } catch (error) {
      if (error instanceof TaskCredentialsError && error.code === 'invalid') throw error;
      if (attempt === 2) throw new TaskCredentialsError('unavailable');
      await new Promise(resolve => setTimeout(resolve, [100, 250][attempt]));
    }
  }
  const parsed = metadataSchema.safeParse(raw);
  if (!parsed.success) throw new TaskCredentialsError('invalid');
  const expiresAt = Date.parse(parsed.data.Expiration);
  if (expiresAt <= now + 5 * 60_000) throw new TaskCredentialsError('expiring');
  return {
    accessKeyId: parsed.data.AccessKeyId,
    secretAccessKey: parsed.data.SecretAccessKey,
    sessionToken: parsed.data.Token,
    expiresAt,
  };
}
