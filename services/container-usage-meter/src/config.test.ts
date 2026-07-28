import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { CONTAINER_USAGE_RECONCILIATION_CRON } from './reconciliation';

type WranglerConfig = {
  triggers?: { crons?: string[] };
  hyperdrive?: { binding?: string }[];
};

describe('container usage meter deployment configuration', () => {
  it('keeps cron and required bindings aligned with source', () => {
    const config = parse(
      fs.readFileSync(path.join(process.cwd(), 'wrangler.jsonc'), 'utf8')
    ) as WranglerConfig;

    expect(config.triggers?.crons).toContain(CONTAINER_USAGE_RECONCILIATION_CRON);
    expect(config.hyperdrive).toContainEqual(expect.objectContaining({ binding: 'HYPERDRIVE' }));
  });
});
