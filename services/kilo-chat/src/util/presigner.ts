import { AwsClient } from 'aws4fetch';

type Cfg = {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function r2Origin(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function makeClient(cfg: Cfg): AwsClient {
  return new AwsClient({
    service: 's3',
    region: 'auto',
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  });
}

export async function mintPutUrl(
  params: Cfg & {
    key: string;
    contentType: string;
    expiresSeconds: number;
  }
): Promise<{ url: string; headers: Record<string, string> }> {
  const url = new URL(`${r2Origin(params.accountId)}/${params.bucket}/${params.key}`);
  url.searchParams.set('X-Amz-Expires', String(params.expiresSeconds));
  const signed = await makeClient(params).sign(
    new Request(url, {
      method: 'PUT',
      headers: { 'Content-Type': params.contentType },
    }),
    { aws: { signQuery: true, allHeaders: true } }
  );
  return {
    url: signed.url,
    headers: { 'Content-Type': params.contentType },
  };
}

export async function mintGetUrl(
  params: Cfg & {
    key: string;
    expiresSeconds: number;
    responseContentDisposition?: string;
  }
): Promise<{ url: string }> {
  const url = new URL(`${r2Origin(params.accountId)}/${params.bucket}/${params.key}`);
  url.searchParams.set('X-Amz-Expires', String(params.expiresSeconds));
  if (params.responseContentDisposition) {
    url.searchParams.set('response-content-disposition', params.responseContentDisposition);
  }
  const signed = await makeClient(params).sign(new Request(url, { method: 'GET' }), {
    aws: { signQuery: true },
  });
  return { url: signed.url };
}
