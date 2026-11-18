import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';

// R2 configuration from environment variables
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

/** Singleton R2 client using the shared `R2_ACCESS_KEY_ID` credentials. */
export const r2Client = createR2Client({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
});

export const r2CliSessionsBucketName = R2_CLI_SESSIONS_BUCKET_NAME;
export const r2CloudAgentAttachmentsBucketName = CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME;
