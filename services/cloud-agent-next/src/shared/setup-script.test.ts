import { describe, expect, it } from 'vitest';
import { setupCommandsSchema as admissionSchema } from '@kilocode/cloud-agent-profile/setup-script';
import { setupCommandsSchema } from './setup-script.js';

describe('standalone wrapper setup script contract', () => {
  it.each([
    { name: 'no scripts', scripts: [] },
    { name: 'multiline script', scripts: ['echo setup\n'.repeat(100)] },
    { name: 'maximum script length', scripts: ['x'.repeat(16_000)] },
    { name: 'excessive script length', scripts: ['x'.repeat(16_001)] },
    { name: 'maximum script count', scripts: Array.from({ length: 20 }, () => 'true') },
    { name: 'excessive script count', scripts: Array.from({ length: 21 }, () => 'true') },
  ])('matches admission validation for $name', ({ scripts }) => {
    expect(setupCommandsSchema.safeParse(scripts).success).toBe(
      admissionSchema.safeParse(scripts).success
    );
  });
});
