import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, it } from 'vitest';

it('keeps the isolated wrapper billing schema identical to its canonical package owner', () => {
  const canonical = readFileSync(
    new URL(
      '../../../../packages/session-ingest-contracts/src/cloud-agent-billing.ts',
      import.meta.url
    ),
    'utf8'
  );
  const standalone = readFileSync(new URL('./cloud-agent-billing.ts', import.meta.url), 'utf8');
  expect(standalone).toBe(canonical);
});
