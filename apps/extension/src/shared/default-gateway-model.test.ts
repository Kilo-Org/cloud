import { describe, expect, it } from 'vitest';
import { getDefaultGatewayModelId } from './default-gateway-model';
import type { KiloGatewayModelOption } from './kilo-api-client';

const model = (id: string, isPreferred = false): KiloGatewayModelOption => ({
  id,
  isPreferred,
  name: id,
  variants: [],
});

describe('default gateway model', () => {
  it('prefers the frontier auto route', () => {
    expect(
      getDefaultGatewayModelId([
        model('aion-labs/aion-3.5'),
        model('kilo-auto/efficient'),
        model('kilo-auto/frontier'),
      ])
    ).toBe('kilo-auto/frontier');
  });

  it('falls back to another auto route when frontier is absent', () => {
    expect(
      getDefaultGatewayModelId([model('aion-labs/aion-3.5'), model('kilo-auto/efficient')])
    ).toBe('kilo-auto/efficient');
  });

  it('uses the preferred catalog model when no auto route is offered', () => {
    expect(
      getDefaultGatewayModelId([
        model('aion-labs/aion-3.5'),
        model('anthropic/claude-sonnet-4', true),
      ])
    ).toBe('anthropic/claude-sonnet-4');
  });

  it('falls back to the first catalog entry', () => {
    expect(getDefaultGatewayModelId([model('aion-labs/aion-3.5'), model('z-ai/glm')])).toBe(
      'aion-labs/aion-3.5'
    );
  });

  it('returns undefined for an empty catalog', () => {
    expect(getDefaultGatewayModelId([])).toBeUndefined();
  });
});
