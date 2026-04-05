import type { ImageMCPTokenClaims } from '../auth/jwt';
import type { createR2Client } from '../r2/client';

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

type TransferImageParams = {
  sourcePath: string;
  claims: ImageMCPTokenClaims;
  r2: ReturnType<typeof createR2Client>;
  bucketPublicUrls: Record<string, string>;
};

async function transferImage(params: TransferImageParams): Promise<string> {
  const { sourcePath, claims, r2, bucketPublicUrls } = params;

  // Validate sourcePath doesn't contain path traversal
  if (sourcePath.includes('..') || sourcePath.startsWith('/')) {
    throw new Error('Access denied: invalid source path');
  }

  const fullSourceKey = `${claims.src_prefix}${sourcePath}`;

  // Read from source bucket
  const sourceObject = await r2.getObject(claims.src_bucket, fullSourceKey);
  if (!sourceObject) {
    throw new Error(`Image not found: ${sourcePath}`);
  }

  // Validate MIME type
  const contentType = sourceObject.contentType;
  if (!contentType || !ALLOWED_MIME_TYPES.includes(contentType)) {
    throw new Error(`Invalid file type: ${contentType}. Only images are allowed.`);
  }

  // Reject oversized objects to avoid memory pressure
  if (sourceObject.contentLength > MAX_IMAGE_SIZE_BYTES) {
    throw new Error(
      `Image too large (${sourceObject.contentLength} bytes). Maximum size is ${MAX_IMAGE_SIZE_BYTES} bytes.`
    );
  }

  // Extract filename and write to destination
  const filename = sourcePath.split('/').pop();
  if (!filename) {
    throw new Error('Invalid source path: no filename');
  }

  const destKey = `${claims.dst_prefix}${filename}`;

  // Read body into ArrayBuffer since we can't tee a ReadableStream across fetch calls
  const arrayBuffer = await new Response(sourceObject.body).arrayBuffer();

  await r2.putObject(claims.dst_bucket, destKey, arrayBuffer, {
    contentType,
  });

  // Look up public URL for destination bucket
  const baseUrl = bucketPublicUrls[claims.dst_bucket];
  if (!baseUrl) {
    throw new Error(`No public URL configured for bucket: ${claims.dst_bucket}`);
  }

  const encodedPath = destKey
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `${baseUrl}/${encodedPath}`;
}

export { transferImage };
