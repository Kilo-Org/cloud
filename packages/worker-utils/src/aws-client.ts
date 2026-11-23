import { AwsClient } from 'aws4fetch';
import { z } from 'zod';

export const awsCredentialsSchema = z.object({
  accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/),
  secretAccessKey: z.string().min(1).max(256),
  sessionToken: z.string().min(1).max(16384).optional(),
  expiresAt: z.number().int().positive().optional(),
});

export type AwsCredentials = z.infer<typeof awsCredentialsSchema>;
export type AwsFetch = (request: Request) => Promise<Response>;

/** Errors deliberately exclude AWS response text, URLs and signed request headers. */
export class AwsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`AWS request failed (${status}, ${code})`);
    this.name = 'AwsRequestError';
  }
}

export function awsRegion(value: string): string {
  return z
    .string()
    .regex(/^[a-z]{2}-[a-z]+-\d$/)
    .parse(value);
}

export function createAwsClient(input: {
  credentials: AwsCredentials;
  region: string;
  service: string;
  fetch?: AwsFetch;
}) {
  const region = awsRegion(input.region);
  const signer = new AwsClient({
    accessKeyId: input.credentials.accessKeyId,
    secretAccessKey: input.credentials.secretAccessKey,
    sessionToken: input.credentials.sessionToken,
    region,
    service: input.service,
    retries: 0,
  });
  const fetcher = input.fetch ?? fetch;
  return {
    async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
      let response: Response;
      try {
        const request = await signer.sign(url.toString(), {
          ...init,
          redirect: 'error',
          signal: init.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
        });
        response = await fetcher(request);
      } catch {
        throw new AwsRequestError(0, 'TransportError');
      }
      if (response.ok) return response;
      const header = response.headers.get('x-amzn-errortype')?.split(':', 1)[0];
      // AWS does not consistently return a typed header. Status remains authoritative.
      const code =
        header && /^[A-Za-z][A-Za-z0-9]{0,80}$/.test(header) ? header : 'RequestRejected';
      await response.body?.cancel();
      throw new AwsRequestError(response.status, code);
    },
    async signedUrl(url: URL, method: 'GET' | 'PUT', expiresInSeconds: number): Promise<string> {
      if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 3600)
        throw new Error('Invalid AWS URL lifetime');
      if (
        input.credentials.expiresAt !== undefined &&
        Date.now() + (expiresInSeconds + 30) * 1000 >= input.credentials.expiresAt
      )
        throw new Error('AWS credentials expire before the signed URL');
      const target = new URL(url);
      target.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
      return (await signer.sign(target.toString(), { method, aws: { signQuery: true } })).url;
    },
  };
}

export async function readAwsResponse(response: Response, maximumBytes = 65_536): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) throw new AwsRequestError(0, 'ResponseTooLarge');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error instanceof AwsRequestError ? error : new AwsRequestError(0, 'ResponseReadError');
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function assumeAwsRole(input: {
  credentials: AwsCredentials;
  region: string;
  roleArn: string;
  externalId?: string;
  fetch?: AwsFetch;
}): Promise<AwsCredentials> {
  const roleArn = z
    .string()
    .regex(/^arn:aws:iam::\d{12}:role\/[A-Za-z0-9+=,.@_/-]+$/)
    .parse(input.roleArn);
  const client = createAwsClient({ ...input, service: 'sts' });
  const body = new URLSearchParams({
    Action: 'AssumeRole',
    Version: '2011-06-15',
    RoleArn: roleArn,
    RoleSessionName: 'kilo-cloud-agent',
    DurationSeconds: '3600',
    ...(input.externalId === undefined ? {} : { ExternalId: input.externalId }),
  });
  const response = await client.request(`https://sts.${awsRegion(input.region)}.amazonaws.com/`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const xml = await readAwsResponse(response);
  function field(name: string): string {
    const match = xml.match(new RegExp(`<${name}>([A-Za-z0-9/+=]+)</${name}>`));
    if (!match?.[1]) throw new AwsRequestError(0, 'InvalidCredentialsResponse');
    return match[1];
  }
  const result = awsCredentialsSchema.safeParse({
    accessKeyId: field('AccessKeyId'),
    secretAccessKey: field('SecretAccessKey'),
    sessionToken: field('SessionToken'),
    expiresAt: Date.parse(xml.match(/<Expiration>([0-9:T.Z+-]+)<\/Expiration>/)?.[1] ?? ''),
  });
  if (!result.success) throw new AwsRequestError(0, 'InvalidCredentialsResponse');
  return result.data;
}
