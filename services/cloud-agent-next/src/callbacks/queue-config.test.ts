import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { CALLBACK_DELIVERY_MAX_ATTEMPTS } from './delivery.js';

type QueueConsumer = { queue?: string; max_retries?: number };
type WranglerConfig = {
  vars?: Record<string, string>;
  queues?: { consumers?: QueueConsumer[] };
  env?: {
    dev?: {
      vars?: Record<string, string>;
      queues?: { consumers?: QueueConsumer[] };
    };
  };
};

const CONFIGURED_REDELIVERIES = CALLBACK_DELIVERY_MAX_ATTEMPTS - 1;

function readWranglerConfig(): WranglerConfig {
  const content = fs.readFileSync(path.join(process.cwd(), 'wrangler.jsonc'), 'utf8');
  return parse(content) as WranglerConfig;
}

describe('callback queue retry configuration', () => {
  it('allows the application callback retry budget in default and dev consumers', () => {
    const config = readWranglerConfig();
    const production = config.queues?.consumers?.find(
      consumer => consumer.queue === 'cloud-agent-next-callback-queue'
    );
    const dev = config.env?.dev?.queues?.consumers?.find(
      consumer => consumer.queue === 'cloud-agent-next-callback-queue-dev'
    );

    expect(production?.max_retries).toBe(CONFIGURED_REDELIVERIES);
    expect(dev?.max_retries).toBe(CONFIGURED_REDELIVERIES);
  });

  it('sets the code-review control-plane rollout, sandbox selection and preview allowlists in wrangler', () => {
    const config = readWranglerConfig();

    expect(config.vars?.VERCEL_SANDBOX_ORG_IDS).toBe('');
    expect(config.vars?.CLOUDFLARE_CONTAINERS_ORG_IDS).toBe('*');
    expect(config.vars?.CODE_REVIEW_CONTROL_PLANE_IDS).toBe('*');
    expect(config.vars?.SANDBOX_SELECTION_IDS).toBe(
      '9d278969-5453-4ae3-a51f-a8d2274a7b56,30f1620a-4aad-4456-bf4d-550f335e6f55'
    );
    expect(config.vars?.PREVIEW_ENABLED_IDS).toBe('');
    expect(config.env?.dev?.vars?.VERCEL_SANDBOX_ORG_IDS).toBe('');
    expect(config.env?.dev?.vars?.CLOUDFLARE_CONTAINERS_ORG_IDS).toBe('*');
    expect(config.env?.dev?.vars?.CODE_REVIEW_CONTROL_PLANE_IDS).toBe('*');
    expect(config.env?.dev?.vars?.SANDBOX_SELECTION_IDS).toBe('*');
    expect(config.env?.dev?.vars?.PREVIEW_ENABLED_IDS).toBe('*');
  });
});
