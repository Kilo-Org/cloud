import { describe, expect, it } from 'vitest';
import {
  CONTROLLER_ENDPOINT_CAPABILITIES,
  KILO_CHAT_ENDPOINT_CAPABILITIES,
  getControllerEndpointCapabilities,
} from './endpoint-capabilities';

describe('getControllerEndpointCapabilities', () => {
  it('returns sorted unique capabilities', () => {
    const capabilities = getControllerEndpointCapabilities();

    expect(capabilities).toEqual([...capabilities].sort());
    expect(capabilities).toHaveLength(new Set(capabilities).size);
    expect(capabilities).toEqual([...new Set(CONTROLLER_ENDPOINT_CAPABILITIES)].sort());
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
});
