import type { ImageMCPTokenClaims } from '../auth/jwt';
import type { createR2Client } from '../r2/client';

const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

type MCPImageContent = {
  type: 'image';
  data: string;
  mimeType: string;
};

type GetImageParams = {
  sourcePath: string;
  claims: ImageMCPTokenClaims;
  r2: ReturnType<typeof createR2Client>;
};

async function getImage(params: GetImageParams): Promise<MCPImageContent> {
  const { sourcePath, claims, r2 } = params;

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

  // Convert to base64
  const arrayBuffer = await new Response(sourceObject.body).arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');

  return {
    type: 'image',
    data: base64,
    mimeType: contentType,
  };
}

export { getImage, type MCPImageContent };
