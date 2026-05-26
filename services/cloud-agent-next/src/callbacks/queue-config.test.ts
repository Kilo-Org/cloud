import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { CALLBACK_DELIVERY_MAX_ATTEMPTS } from './delivery.js';

type QueueConsumer = { queue?: string; max_retries?: number };
type WranglerConfig = {
  queues?: { consumers?: QueueConsumer[] };
  env?: { dev?: { queues?: { consumers?: QueueConsumer[] } } };
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
});
