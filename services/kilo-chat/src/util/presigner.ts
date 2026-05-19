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
    contentLength: number;
    expiresSeconds: number;
  }
): Promise<{ url: string; headers: Record<string, string> }> {
  const url = new URL(`${r2Origin(params.accountId)}/${params.bucket}/${params.key}`);
  url.searchParams.set('X-Amz-Expires', String(params.expiresSeconds));
  // Sign Content-Type and Content-Length into the URL so R2 rejects mismatched
  // uploads — without this, a caller that declared size N can PUT arbitrary
  // bytes and the row's `size` no longer reflects reality.
  const headers = {
    'Content-Type': params.contentType,
    'Content-Length': String(params.contentLength),
  };
  const signed = await makeClient(params).sign(new Request(url, { method: 'PUT', headers }), {
    aws: { signQuery: true, allHeaders: true },
  });
  return { url: signed.url, headers };
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
