import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { kiloChatPlugin } from './channel.js';

export default defineChannelPluginEntry({
  id: 'kilo-chat',
  name: 'Kilo Chat',
  description: 'Kilo Chat channel plugin',
  plugin: kiloChatPlugin,
});
