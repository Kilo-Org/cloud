import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION,
  CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS,
} from '@/lib/cloud-agent/constants';
import type { CloudAgentImageAllowedType } from '@/lib/cloud-agent/constants';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';

type Service = 'app-builder';

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
