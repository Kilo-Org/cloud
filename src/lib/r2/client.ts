import { S3Client } from '@aws-sdk/client-s3';
import { getEnvVariable } from '@/lib/dotenvx';

// R2 configuration from environment variables (lazy-loaded to avoid breaking the app at startup)
function getR2Config() {
  const R2_ACCOUNT_ID = getEnvVariable('R2_ACCOUNT_ID');
  const R2_ACCESS_KEY_ID = getEnvVariable('R2_ACCESS_KEY_ID');
  const R2_SECRET_ACCESS_KEY = getEnvVariable('R2_SECRET_ACCESS_KEY');
  const R2_CLI_SESSIONS_BUCKET_NAME = getEnvVariable('R2_CLI_SESSIONS_BUCKET_NAME');
  const CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME = getEnvVariable(
    'CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME'
  );

  if (!R2_ACCOUNT_ID) {
    throw new Error('R2_ACCOUNT_ID environment variable is required');
  }

  if (!R2_ACCESS_KEY_ID) {
    throw new Error('R2_ACCESS_KEY_ID environment variable is required');
  }

  if (!R2_SECRET_ACCESS_KEY) {
    throw new Error('R2_SECRET_ACCESS_KEY environment variable is required');
  }

  if (!R2_CLI_SESSIONS_BUCKET_NAME) {
    throw new Error('R2_CLI_SESSIONS_BUCKET_NAME environment variable is required');
  }

  return {
    R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
    R2_CLI_SESSIONS_BUCKET_NAME,
    CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME,
  };
}

let _r2Client: S3Client | null = null;
let _r2CliSessionsBucketName: string | null = null;
let _r2CloudAgentAttachmentsBucketName: string | undefined = undefined;

function initR2Client() {
  if (_r2Client) return;

  const config = getR2Config();

  _r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY,
    },
  });

  _r2CliSessionsBucketName = config.R2_CLI_SESSIONS_BUCKET_NAME;
  _r2CloudAgentAttachmentsBucketName = config.CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME;
}

/**
 * Singleton S3 client configured for Cloudflare R2.
 *
 * R2 is Cloudflare's S3-compatible object storage service.
 * The client is configured with R2-specific endpoint and credentials.
 *
 * Note: This is lazy-initialized to avoid breaking the app at startup
 * when R2 environment variables are not configured.
 */
export const r2Client = {
  send: (...args: Parameters<S3Client['send']>) => {
    initR2Client();
    if (!_r2Client) {
      throw new Error('R2 client failed to initialize');
    }
    return _r2Client.send(...args);
  },
} as S3Client;

export function getR2CliSessionsBucketName(): string {
  initR2Client();
  if (!_r2CliSessionsBucketName) {
    throw new Error('R2 CLI sessions bucket name not configured');
  }
  return _r2CliSessionsBucketName;
}

export function getR2CloudAgentAttachmentsBucketName(): string | undefined {
  initR2Client();
  return _r2CloudAgentAttachmentsBucketName;
}
