export const CONTROLLER_API_VERSION = 1;

export const CONTROLLER_ENDPOINT_CAPABILITIES = [
  'config.read',
  'config.restore',
  'config.replace',
  'config.patch',
  'config.agents.read',
  'config.agents.create.basic.cli',
  'config.agents.update',
  'config.agents.delete.cli',
  'config.agent-defaults.update',
  'config.tools-md.google-workspace',
  'env.patch',
  'doctor.run',
  'kilo-cli.run',
  'files.tree',
  'files.tree.path',
  'files.read',
  'files.write',
  'files.write-openclaw-config',
  'files.import-openclaw-workspace',
  'profile.bot-identity',
  'profile.user-profile',
  'gateway.lifecycle',
  'gateway.ready',
  'morning-briefing.status',
  'morning-briefing.actions',
  'morning-briefing.interests',
  'morning-briefing.user-location',
  'morning-briefing.read',
  'pairing.channels',
  'pairing.devices',
  'google-oauth.token',
  'google-oauth.status',
  'gmail.pubsub',
  'hooks.email',
] as const;

export const KILO_CHAT_ENDPOINT_CAPABILITIES = [
  'kilo-chat.messages.send',
  'kilo-chat.messages.update',
  'kilo-chat.messages.delete',
  'kilo-chat.messages.reactions',
  'kilo-chat.typing',
  'kilo-chat.conversations.read',
  'kilo-chat.conversations.create',
  'kilo-chat.conversations.update',
  'kilo-chat.conversations.members.read',
  'kilo-chat.bot-status.update',
  'kilo-chat.conversation-status.update',
  'kilo-chat.delivery-failed',
  'kilo-chat.attachments',
] as const;

export type ControllerEndpointCapability =
  | (typeof CONTROLLER_ENDPOINT_CAPABILITIES)[number]
  | (typeof KILO_CHAT_ENDPOINT_CAPABILITIES)[number];

export function getControllerEndpointCapabilities(options?: {
  includeKiloChatCapabilities?: boolean;
}): ControllerEndpointCapability[] {
  const capabilities = options?.includeKiloChatCapabilities
    ? [...CONTROLLER_ENDPOINT_CAPABILITIES, ...KILO_CHAT_ENDPOINT_CAPABILITIES]
    : CONTROLLER_ENDPOINT_CAPABILITIES;
  return [...new Set<ControllerEndpointCapability>(capabilities)].sort();
}
