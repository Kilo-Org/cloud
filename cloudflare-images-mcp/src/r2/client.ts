import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';

type R2Config = {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
};

type R2Object = {
  body: ReadableStream;
  contentType: string | null;
  contentLength: number;
};

type R2ListEntry = {
  key: string;
  size: number;
  lastModified: string;
};

type R2ListResult = {
  objects: R2ListEntry[];
  isTruncated: boolean;
  nextContinuationToken: string | undefined;
};

const xmlParser = new XMLParser();

function parseListObjectsV2Response(xml: string): R2ListResult {
  const parsed: Record<string, unknown> = xmlParser.parse(xml) as Record<string, unknown>;
  const result = parsed.ListBucketResult as Record<string, unknown>;

  const isTruncated = result.IsTruncated === true || result.IsTruncated === 'true';
  const nextContinuationToken = result.NextContinuationToken as string | undefined;

  // Contents may be absent (empty), a single object, or an array
  const raw = result.Contents;
  const entries: unknown[] = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];

  const objects: R2ListEntry[] = entries.map(entry => {
    const e = entry as Record<string, unknown>;
    return {
      key: String(e.Key),
      size: Number(e.Size),
      lastModified: String(e.LastModified),
    };
  });

  return { objects, isTruncated, nextContinuationToken };
}

function createR2Client(config: R2Config) {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });

  async function getObject(bucket: string, key: string): Promise<R2Object | null> {
    const url = new URL(`/${bucket}/${key}`, config.endpoint);
    const response = await aws.fetch(url.toString(), { method: 'GET' });

    if (response.status === 404) {
      console.log(`R2 GET ${bucket}/${key} → 404`);
      return null;
    }
    if (!response.ok) {
      throw new Error(`R2 GET failed: ${response.status} ${response.statusText}`);
    }

    const body = response.body;
    if (!body) {
      throw new Error(`R2 GET returned empty body for: ${bucket}/${key}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') ?? '0', 10);
    console.log(`R2 GET ${bucket}/${key} → ${contentLength} bytes`);

    return {
      body,
      contentType: response.headers.get('content-type'),
      contentLength,
    };
  }

  async function putObject(
    bucket: string,
    key: string,
    body: ReadableStream | ArrayBuffer,
    options: { contentType: string }
  ): Promise<void> {
    const url = new URL(`/${bucket}/${key}`, config.endpoint);
    const response = await aws.fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
      body,
    });

    if (!response.ok) {
      throw new Error(`R2 PUT failed: ${response.status} ${response.statusText}`);
    }
    console.log(`R2 PUT ${bucket}/${key} → ${options.contentType}`);
  }

  async function listObjects(
    bucket: string,
    prefix: string,
    options?: { maxKeys?: number; continuationToken?: string }
  ): Promise<R2ListResult> {
    const url = new URL(`/${bucket}`, config.endpoint);
    url.searchParams.set('list-type', '2');
    url.searchParams.set('prefix', prefix);
    if (options?.maxKeys) {
      url.searchParams.set('max-keys', String(options.maxKeys));
    }
    if (options?.continuationToken) {
      url.searchParams.set('continuation-token', options.continuationToken);
    }

    const response = await aws.fetch(url.toString(), { method: 'GET' });
    if (!response.ok) {
      throw new Error(`R2 LIST failed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();
    const parsed = parseListObjectsV2Response(xml);

    console.log(`R2 LIST ${bucket} prefix=${prefix} → ${parsed.objects.length} objects`);
    return parsed;
  }

  return { getObject, putObject, listObjects };
}

export { createR2Client, type R2Object, type R2ListEntry, type R2ListResult };
