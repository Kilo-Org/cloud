import { reset } from 'cloudflare:test';
import { beforeEach } from 'vitest';

beforeEach(async () => {
  await reset();
});
