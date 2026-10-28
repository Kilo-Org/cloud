import { CloudAgentRunContainerSchema } from '@kilocode/worker-utils/cloud-agent-queue-report';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_PLANE_RUN_CONTAINER_PROVIDERS,
  controlPlaneRunContainerSchema,
} from './control-plane-protocol.js';

const validContainer = {
  provider: 'vercel',
  sandboxId: 'sb_123',
  allocationId: 'alloc_1',
  imageRef: 'vercel/sandbox:1',
  startSource: 'image',
};

const invalidContainers = [
  ['missing sandboxId', { ...validContainer, sandboxId: undefined }],
  ['empty sandboxId', { ...validContainer, sandboxId: '' }],
  ['oversized sandboxId', { ...validContainer, sandboxId: 'x'.repeat(129) }],
  ['oversized imageRef', { ...validContainer, imageRef: 'x'.repeat(1025) }],
  ['unknown provider', { ...validContainer, provider: 'aws' }],
  ['unknown startSource', { ...validContainer, startSource: 'clone' }],
  ['extra property', { ...validContainer, unknownFact: true }],
] as const;

describe('controlPlaneRunContainerSchema', () => {
  it('mirrors the worker-utils provider set', () => {
    expect(CONTROL_PLANE_RUN_CONTAINER_PROVIDERS).toEqual(
      CloudAgentRunContainerSchema.shape.provider.options
    );
  });

  it('accepts a container that worker-utils accepts', () => {
    expect(CloudAgentRunContainerSchema.safeParse(validContainer).success).toBe(true);
    expect(controlPlaneRunContainerSchema.safeParse(validContainer).success).toBe(true);
  });

  for (const [name, container] of invalidContainers) {
    it(`rejects ${name} like worker-utils`, () => {
      expect(CloudAgentRunContainerSchema.safeParse(container).success).toBe(false);
      expect(controlPlaneRunContainerSchema.safeParse(container).success).toBe(false);
    });
  }
});
