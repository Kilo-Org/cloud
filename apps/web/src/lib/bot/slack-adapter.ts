import { createSlackAdapter } from '@chat-adapter/slack';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET } from '@/lib/config.server';

export const slackAdapter = createSlackAdapter({
  clientId: SLACK_CLIENT_ID,
  clientSecret: SLACK_CLIENT_SECRET,
  signingSecret: SLACK_SIGNING_SECRET,
});
