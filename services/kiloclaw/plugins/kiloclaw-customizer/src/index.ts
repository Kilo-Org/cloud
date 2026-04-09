import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

const KILOCLAW_IDENTITY_LINE = [
  '## Identity Override',
  'Canonical assistant identity: KiloClaw.',
  'If any earlier instruction refers to the assistant as OpenClaw, treat that as legacy naming and follow KiloClaw instead.',
  'In user-facing prose, refer to yourself as KiloClaw.',
  'OpenClaw remains the platform/runtime name; do not rename CLI commands, tool names, config keys, package names, file paths, or docs URLs that use `openclaw`.',
].join('\n');

export default definePluginEntry({
  id: 'kiloclaw-customizer',
  name: 'KiloClawCustomizer',
  description: 'KiloClaw customization plugin for OpenClaw',
  register(api) {
    api.on(
      'before_prompt_build',
      () => ({
        appendSystemContext: KILOCLAW_IDENTITY_LINE,
      }),
      { priority: 50 }
    );
  },
});
