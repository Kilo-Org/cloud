import { describe, expect, it } from 'vitest';
import { PREVIEW_HOST_TEMPLATE_PORT } from '../../preview/host.js';
import type { Env, TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { getPreviewOptions } from './preview-options.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';
const HOST_TEMPLATE = `p${PREVIEW_HOST_TEMPLATE_PORT}-11111111111141118111111111111111.preview.test`;

function callerFor(env: Partial<Env>, userId = 'user-1') {
  return router({ getPreviewOptions }).createCaller({
    env: { PREVIEW_HOST_SUFFIX: 'preview.test', ...env } as Env,
    userId,
    authToken: 'token',
    request: new Request('http://worker.test/trpc'),
  } satisfies TRPCContext);
}

describe('getPreviewOptions', () => {
  it.each([
    [undefined, undefined, false],
    ['', undefined, false],
    ['user-2', undefined, false],
    ['user-1', undefined, true],
    ['org-1', undefined, false],
    ['org-1', 'org-1', true],
    ['*', undefined, true],
  ] as const)(
    'gates PREVIEW_ENABLED_IDS=%s for user-1 in org %s as %s',
    async (ids, organizationId, enabled) => {
      const result = await callerFor({ PREVIEW_ENABLED_IDS: ids }).getPreviewOptions({
        cloudAgentSessionId: SESSION_ID,
        organizationId,
      });
      expect(result).toEqual(
        enabled ? { enabled: true, hostTemplate: HOST_TEMPLATE } : { enabled: false }
      );
    }
  );

  it('stays off without a preview suffix even for an enrolled owner', async () => {
    const caller = callerFor({ PREVIEW_HOST_SUFFIX: '', PREVIEW_ENABLED_IDS: '*' });
    await expect(caller.getPreviewOptions({ cloudAgentSessionId: SESSION_ID })).resolves.toEqual({
      enabled: false,
    });
  });
});
