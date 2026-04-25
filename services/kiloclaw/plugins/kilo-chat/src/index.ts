import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/core';
import { kiloChatPlugin } from './channel.js';
import { createKiloChatWebhookHandler } from './webhook/index.js';

export default defineChannelPluginEntry({
  id: 'kilo-chat',
  name: 'Kilo Chat',
  description: 'Kilo Chat channel plugin',
  plugin: kiloChatPlugin,
  registerFull(api) {
    api.registerHttpRoute({
      path: '/plugins/kilo-chat/webhook',
      match: 'exact',
      auth: 'gateway',
      handler: createKiloChatWebhookHandler({ api }),
    });
  },
});
