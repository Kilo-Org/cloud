// Compile every zod schema built after this point into flat validation code.
// Must stay the first import: the compiler only sees schemas constructed after
// it installs. Node and Bun only — workerd and MV3 forbid `new Function()`.
import 'zod/compile';
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
