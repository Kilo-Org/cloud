import { describe, expect, it } from 'vitest';
import { CODE_REVIEW_PUBLICATION_SELF_CHECK_ENV as producerEnv } from '@kilocode/worker-utils/code-review-self-check';
import { CODE_REVIEW_PUBLICATION_SELF_CHECK_ENV as wrapperEnv } from './code-review-self-check.js';

describe('code-review publication self-check env contract', () => {
  it('matches the env var the review producer sets', () => {
    expect(wrapperEnv).toBe(producerEnv);
  });
});
