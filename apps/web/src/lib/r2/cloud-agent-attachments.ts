import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION,
  CLOUD_AGENT_IMAGE_PRESIGNED_URL_EXPIRY_SECONDS,
} from '@/lib/cloud-agent/constants';
import type { CloudAgentImageAllowedType } from '@/lib/cloud-agent/constants';
import { r2Client, r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';

type Service = 'app-builder' | 'cloud-agent';

function getExtensionFromContentType(contentType: CloudAgentImageAllowedType): string {
  return CLOUD_AGENT_IMAGE_MIME_TO_EXTENSION[contentType];
}

export type GetImageAttachmentPathParams = {
  service: Service;
  userId: string;
  messageUuid: string;
  imageId: string;
  contentType: CloudAgentImageAllowedType;
};

export type GetImageAttachmentPathResult = {
  filename: string;
  key: string;
};

export function getImageAttachmentPath({
  service,
  userId,
  messageUuid,
  imageId,
  contentType,
}: GetImageAttachmentPathParams): GetImageAttachmentPathResult {
  const ext = getExtensionFromContentType(contentType);
  const filename = `${imageId}.${ext}`;

  return {
    filename,
    key: `${userId}/${service}/${messageUuid}/${filename}`,
  };
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

export type UploadImageAttachmentParams = GetImageAttachmentPathParams & {
  body: Uint8Array;
};

export type UploadImageAttachmentResult = GetImageAttachmentPathResult;

function getImageAttachmentPutObjectCommand({
  key,
  userId,
  messageUuid,
  imageId,
  contentType,
  contentLength,
  body,
}: {
  key: string;
  userId: string;
  messageUuid: string;
  imageId: string;
  contentType: CloudAgentImageAllowedType;
  contentLength: number;
  body?: Uint8Array;
}): PutObjectCommand {
  const bodyInput = body === undefined ? {} : { Body: body };

  return new PutObjectCommand({
    Bucket: r2CloudAgentAttachmentsBucketName,
    Key: key,
    ContentType: contentType,
    ContentLength: contentLength,
    Metadata: {
      userId,
      messageUuid,
      imageId,
    },
    ...bodyInput,
  });
}

export async function uploadImageAttachment({
  service,
  userId,
  messageUuid,
  imageId,
  contentType,
  body,
}: UploadImageAttachmentParams): Promise<UploadImageAttachmentResult> {
  const { filename, key } = getImageAttachmentPath({
    service,
    userId,
    messageUuid,
    imageId,
    contentType,
  });

  await r2Client.send(
    getImageAttachmentPutObjectCommand({
      key,
      userId,
      messageUuid,
      imageId,
      contentType,
      contentLength: body.byteLength,
      body,
    })
  );

  return { filename, key };
}

export async function generateImageUploadUrl({
  service,
  userId,
  messageUuid,
  imageId,
  contentType,
  contentLength,
}: GenerateImageUploadUrlParams): Promise<GenerateImageUploadUrlResult> {
  const { key } = getImageAttachmentPath({
    service,
    userId,
    messageUuid,
    imageId,
    contentType,
  });

  const command = getImageAttachmentPutObjectCommand({
    key,
    userId,
    messageUuid,
    imageId,
    contentType,
    contentLength,
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
