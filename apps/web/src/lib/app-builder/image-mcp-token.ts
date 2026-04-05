import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import { r2CloudAgentAttachmentsBucketName } from '@/lib/r2/client';
import { getEnvVariable } from '@/lib/dotenvx';

type GenerateImageMCPTokenParams = {
  userId: string;
  projectId: string;
  owner: { type: 'user' | 'org'; id: string };
};

function getAppBuilderAssetsBucketName(): string {
  const name = getEnvVariable('APP_BUILDER_ASSETS_BUCKET_NAME');
  if (!name) {
    throw new Error('APP_BUILDER_ASSETS_BUCKET_NAME environment variable is required');
  }
  return name;
}

function generateImageMCPToken(params: GenerateImageMCPTokenParams): string {
  const { userId, projectId, owner } = params;

  const ownerPrefix = owner.type === 'user' ? `user_${owner.id}` : `org_${owner.id}`;

  const payload = {
    src_bucket: r2CloudAgentAttachmentsBucketName,
    src_prefix: `${userId}/app-builder/`,
    dst_bucket: getAppBuilderAssetsBucketName(),
    dst_prefix: `${ownerPrefix}/${projectId}/`,
    project_id: projectId,
    user_id: userId,
  };

  return jwt.sign(payload, NEXTAUTH_SECRET, {
    algorithm: 'HS256',
    expiresIn: '5d',
  });
}

export { generateImageMCPToken };
