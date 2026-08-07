import { createSlackAdapter } from '@chat-adapter/slack';
import {
  SLACK_CLIENT_ID,
  SLACK_CLIENT_SECRET,
  SLACK_ENCRYPTION_KEY,
  SLACK_SIGNING_SECRET,
} from '@/lib/config.server';

export const slackAdapter = createSlackAdapter({
  clientId: SLACK_CLIENT_ID,
  clientSecret: SLACK_CLIENT_SECRET,
  signingSecret: SLACK_SIGNING_SECRET,
  // Encrypts `botToken` at rest in the Chat SDK state store. Passed explicitly
  // rather than relying on the adapter's `process.env.SLACK_ENCRYPTION_KEY`
  // fallback so the dependency is visible here.
  //
  // The `|| undefined` matters: the adapter resolves this with `??`, so an
  // empty string (what `getEnvVariable` returns for an unset variable) would
  // both suppress that fallback and silently disable encryption.
  encryptionKey: SLACK_ENCRYPTION_KEY || undefined,
});
