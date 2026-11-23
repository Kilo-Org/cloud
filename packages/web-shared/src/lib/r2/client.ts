import { getEnvVariable, requireEnv } from '@kilocode/web-shared/lib/dotenvx';
import { createR2Client } from '@kilocode/web-shared/lib/r2/create-client';

// R2 is required at startup, so every exported bucket name is non-empty by construction.
// `createR2Client` reads the account id itself, so this call only enforces the startup check.
requireEnv('R2_ACCOUNT_ID', getEnvVariable('R2_ACCOUNT_ID'));
const R2_ACCESS_KEY_ID = requireEnv('R2_ACCESS_KEY_ID', getEnvVariable('R2_ACCESS_KEY_ID'));
const R2_SECRET_ACCESS_KEY = requireEnv(
  'R2_SECRET_ACCESS_KEY',
  getEnvVariable('R2_SECRET_ACCESS_KEY')
);
const R2_CLI_SESSIONS_BUCKET_NAME = requireEnv(
  'R2_CLI_SESSIONS_BUCKET_NAME',
  getEnvVariable('R2_CLI_SESSIONS_BUCKET_NAME')
);
const CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME = requireEnv(
  'CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME',
  getEnvVariable('CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME')
);

/** Singleton R2 client using the shared `R2_ACCESS_KEY_ID` credentials. */
export const r2Client = createR2Client({
  accessKeyId: R2_ACCESS_KEY_ID,
  secretAccessKey: R2_SECRET_ACCESS_KEY,
});

export const r2CliSessionsBucketName = R2_CLI_SESSIONS_BUCKET_NAME;
export const r2CloudAgentAttachmentsBucketName = CLOUD_AGENT_R2_ATTACHMENTS_BUCKET_NAME;
