import { describe, expect, it } from 'vitest';
import {
  CLOUD_AGENT_BUILTIN_AGENTS,
  CLOUD_AGENT_BUILTIN_AGENT_SLUGS,
} from '@kilocode/cloud-agent-profile';
import {
  RUNTIME_BUILTIN_AGENT_SLUGS,
  RUNTIME_DISABLEABLE_BUILTIN_AGENT_SLUGS,
} from './runtime-profile.js';

describe('built-in agent parity', () => {
  it('keeps the runtime slug list in sync with the profile settings list', () => {
    expect([...RUNTIME_BUILTIN_AGENT_SLUGS]).toEqual([...CLOUD_AGENT_BUILTIN_AGENT_SLUGS]);
  });

  it('keeps disableable slugs in sync with the profile definitions', () => {
    expect([...RUNTIME_DISABLEABLE_BUILTIN_AGENT_SLUGS]).toEqual(
      CLOUD_AGENT_BUILTIN_AGENTS.filter(agent => agent.canDisable).map(agent => agent.slug)
    );
  });
});
