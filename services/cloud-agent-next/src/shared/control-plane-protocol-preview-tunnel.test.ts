import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  controlPlaneWrapperFrameSchema,
} from './control-plane-protocol.js';

const hello = {
  type: 'hello',
  wrapperId: 'wr_1',
  allocationId: '00000000-0000-4000-8000-000000000001',
  protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION,
};

describe('preview tunnel control frames', () => {
  it('accepts the previewTunnel hello capability and keeps the hello strict', () => {
    expect(
      controlPlaneWrapperFrameSchema.safeParse({ ...hello, previewTunnel: true }).success
    ).toBe(true);
    expect(controlPlaneWrapperFrameSchema.safeParse(hello).success).toBe(true);
    expect(
      controlPlaneWrapperFrameSchema.safeParse({ ...hello, previewTunnel: false }).success
    ).toBe(false);
    expect(
      controlPlaneWrapperFrameSchema.safeParse({ ...hello, previewUnknown: true }).success
    ).toBe(false);
  });

  it('accepts a preview.tunnel frame that carries nothing else', () => {
    expect(controlPlaneWrapperFrameSchema.parse({ type: 'preview.tunnel' })).toEqual({
      type: 'preview.tunnel',
    });
    expect(
      controlPlaneWrapperFrameSchema.safeParse({ type: 'preview.tunnel', url: 'wss://x' }).success
    ).toBe(false);
  });
});
