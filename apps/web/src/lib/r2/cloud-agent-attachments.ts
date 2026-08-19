import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS,
  CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION,
  CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS,
  CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION,
  CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS,
  normalizeAttachmentExtension,
  type CloudAgentAttachmentAllowedType,
  type CloudAgentImageAllowedType,
} from '@/lib/cloud-agent/constants';
import { cloudAgentRelaxedAttachmentFilenameSchema } from '@/routers/cloud-agent-next-schemas';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
import { db } from '@/lib/drizzle';
import { cloud_agent_attachment_uploads } from '@kilocode/db/schema';

type Service = 'app-builder' | 'cloud-agent';

function getExtensionFromContentType(contentType: CloudAgentImageAllowedType): string {
  return CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION[contentType];
}

function getImageKey(
  service: Service,
  userId: string,
  messageUuid: string,
  imageId: string,
  contentType: CloudAgentImageAllowedType
): string {
  const ext = getExtensionFromContentType(contentType);
  return `${userId}/${service}/${messageUuid}/${imageId}.${ext}`;
}

export type GenerateImageUploadUrlParams = {
  service: Service;
  userId: string;
  messageUuid: string;
  imageId: string;
  contentType: CloudAgentImageAllowedType;
  contentLength: number;
};

export type GenerateImageUploadUrlResult = {
  signedUrl: string;
  key: string;
  expiresAt: string;
};

export async function generateImageUploadUrl({
  service,
  userId,
  messageUuid,
  imageId,
  contentType,
  contentLength,
}: GenerateImageUploadUrlParams): Promise<GenerateImageUploadUrlResult> {
  const key = getImageKey(service, userId, messageUuid, imageId, contentType);

  const command = new PutObjectCommand({
    Bucket: r2CloudAgentAttachmentsBucketName,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
    Metadata: {
      userId,
      messageUuid,
      imageId,
    },
  });

  const signedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS,
    signableHeaders: new Set(['content-length', 'content-type']),
  });

  const expiresAt = new Date(
    Date.now() + CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS * 1000
  ).toISOString();

  return {
    signedUrl,
    key,
    expiresAt,
  };
}

export type GenerateCloudAgentAttachmentUploadUrlParams = {
  userId: string;
  messageUuid: string;
  attachmentId: string;
  contentType: CloudAgentAttachmentAllowedType | (string & {});
  contentLength: number;
  /**
   * Optional caller-supplied extension. When provided, the R2 key suffix
   * derives from the validated extension (after deny-list filtering and
   * normalization) and `contentType` is treated as a relaxed MIME label.
   * When omitted, the legacy MIME→extension map is used.
   */
  extension?: string;
};

export type GenerateCloudAgentAttachmentUploadUrlResult = {
  signedUrl: string;
  key: string;
  expiresAt: string;
};

export async function generateCloudAgentAttachmentUploadUrl({
  userId,
  messageUuid,
  attachmentId,
  contentType,
  contentLength,
  extension,
}: GenerateCloudAgentAttachmentUploadUrlParams): Promise<GenerateCloudAgentAttachmentUploadUrlResult> {
  const suffix = extension
    ? (() => {
        const normalized = normalizeAttachmentExtension(extension);
        if ((CLOUD_AGENT_ATTACHMENT_DENIED_EXTENSIONS as readonly string[]).includes(normalized)) {
          throw new Error(`Attachment extension "${normalized}" is not allowed`);
        }
        return normalized;
      })()
    : CLOUD_AGENT_ATTACHMENT_MIME_TO_EXTENSION[contentType as CloudAgentAttachmentAllowedType];
  const key = `${userId}/cloud-agent/${messageUuid}/${attachmentId}.${suffix}`;
  const command = new PutObjectCommand({
    Bucket: r2CloudAgentAttachmentsBucketName,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
    Metadata: {
      userId,
      messageUuid,
      attachmentId,
    },
  });

  const signedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS,
    signableHeaders: new Set(['content-length', 'content-type']),
  });

  // Write the TTL ledger row before returning the signed URL so the reaper can
  // track unconsumed objects. `onConflictDoNothing` keeps a re-presign of the
  // same key (e.g. a retried upload) from erroring on the unique `r2_key`.
  await db
    .insert(cloud_agent_attachment_uploads)
    .values({ user_id: userId, r2_key: key })
    .onConflictDoNothing({ target: cloud_agent_attachment_uploads.r2_key });

  return {
    signedUrl,
    key,
    expiresAt: new Date(
      Date.now() + CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS * 1000
    ).toISOString(),
  };
}

/**
 * Mark the caller's uploaded attachments as consumed server-side, so the TTL
 * reaper never deletes an object a sent message still references. Old clients
 * never call `markAttachmentsSent`, so the send mutations mark the rows for the
 * wire payload they already carry. `attachments` is the wire shape
 * `{ path: messageUuid, files: [basename] }`; the full key is rebuilt here.
 */
export async function markCloudAgentAttachmentUploadsConsumed(params: {
  userId: string;
  attachments?: { path: string; files: string[] };
}): Promise<void> {
  const { userId, attachments } = params;
  if (!attachments || attachments.files.length === 0) {
    return;
  }
  const keys = attachments.files.map(
    file => `${userId}/cloud-agent/${attachments.path}/${file}`
  );
  await db
    .update(cloud_agent_attachment_uploads)
    .set({ consumed_at: sql`now()` })
    .where(
      and(
        eq(cloud_agent_attachment_uploads.user_id, userId),
        inArray(cloud_agent_attachment_uploads.r2_key, keys)
      )
    );
}

export type GenerateCloudAgentAttachmentDownloadUrlParams = {
  userId: string;
  messageUuid: string;
  filename: string;
};

export type GenerateCloudAgentAttachmentDownloadUrlResult = {
  signedUrl: string;
  key: string;
  expiresAt: string;
};

/**
 * Presign a GET for a stored attachment. The key prefix is derived from the
 * caller (author) — do NOT reproduce the session-owner divergence here. The
 * filename is re-validated through the shared relaxed-regex + deny-list
 * schema so the key can never contain an unsafe basename regardless of the
 * caller. No org mirror: remote CLI sessions are personal.
 */
export async function generateCloudAgentAttachmentDownloadUrl({
  userId,
  messageUuid,
  filename,
}: GenerateCloudAgentAttachmentDownloadUrlParams): Promise<GenerateCloudAgentAttachmentDownloadUrlResult> {
  // The schema throws on violation; the caller is responsible for passing a
  // parsed value, but we re-validate here as a defense in depth.
  const parsed = cloudAgentRelaxedAttachmentFilenameSchema.parse(filename);
  const key = `${userId}/cloud-agent/${messageUuid}/${parsed}`;

  const command = new GetObjectCommand({
    Bucket: r2CloudAgentAttachmentsBucketName,
    Key: key,
  });

  const signedUrl = await getSignedUrl(r2Client, command, {
    expiresIn: CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS,
  });

  return {
    signedUrl,
    key,
    expiresAt: new Date(
      Date.now() + CLOUD_AGENT_ATTACHMENT_PRESIGNED_URL_EXPIRY_SECONDS * 1000
    ).toISOString(),
  };
}
