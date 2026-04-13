import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { kiloChatPlugin } from './channel.js';
import { createKiloChatWebhookHandler } from './webhook.js';

export default defineChannelPluginEntry({
  id: 'kilo-chat',
  name: 'Kilo Chat',
  description: 'Kilo Chat channel plugin',
  plugin: kiloChatPlugin,
  registerFull(api) {
    if (!process.env.KILOCHAT_WEBHOOK_SECRET) {
      console.warn(
        '[kilo-chat] KILOCHAT_WEBHOOK_SECRET not set — inbound webhook will return 503 until configured'
      );
    }
    api.registerHttpRoute({
      path: '/plugins/kilo-chat/webhook',
      match: 'exact',
      auth: 'plugin',
      handler: createKiloChatWebhookHandler({
        api,
        getWebhookSecret: () => process.env.KILOCHAT_WEBHOOK_SECRET,
      }),
    });
  },
});
