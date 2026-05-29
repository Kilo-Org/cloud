import { describe, expect, it } from 'vitest';
import {
  CONTROLLER_ENDPOINT_CAPABILITIES,
  KILO_CHAT_ENDPOINT_CAPABILITIES,
  getControllerEndpointCapabilities,
} from './endpoint-capabilities';

const CAPABILITY_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)*$/;

describe('getControllerEndpointCapabilities', () => {
  it('returns sorted unique capabilities', () => {
    const capabilities = getControllerEndpointCapabilities();

    expect(capabilities).toEqual([...capabilities].sort());
    expect(capabilities).toHaveLength(new Set(capabilities).size);
    expect(capabilities).toEqual([...new Set(CONTROLLER_ENDPOINT_CAPABILITIES)].sort());
  });

  it('advertises operation-specific agent CRUD capabilities', () => {
    expect(getControllerEndpointCapabilities()).toEqual(
      expect.arrayContaining([
        'config.agents.read',
        'config.agents.create.basic.cli',
        'config.agents.update',
        'config.agents.delete.cli',
        'config.agent-defaults.update',
      ])
    );
  });

  it('advertises validation-aware OpenClaw file writes', () => {
    expect(getControllerEndpointCapabilities()).toContain('files.write-openclaw-config');
  });

  it('includes conditional Kilo Chat capabilities only when requested', () => {
    const defaultCapabilities = getControllerEndpointCapabilities();
    const kiloChatCapabilities = getControllerEndpointCapabilities({
      includeKiloChatCapabilities: true,
    });

    expect(defaultCapabilities).not.toContain('kilo-chat.attachments');
    for (const capability of KILO_CHAT_ENDPOINT_CAPABILITIES) {
      expect(kiloChatCapabilities).toContain(capability);
    }
    expect(kiloChatCapabilities).toEqual([...kiloChatCapabilities].sort());
    expect(kiloChatCapabilities).toHaveLength(new Set(kiloChatCapabilities).size);
  });

  it('only contains names accepted by the Worker schema', () => {
    for (const capability of [
      ...CONTROLLER_ENDPOINT_CAPABILITIES,
      ...KILO_CHAT_ENDPOINT_CAPABILITIES,
    ]) {
      expect(capability).toMatch(CAPABILITY_NAME_PATTERN);
    }
  });
});
