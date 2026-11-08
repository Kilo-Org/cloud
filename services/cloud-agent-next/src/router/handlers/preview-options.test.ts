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
  it('offers preview to every owner when the suffix is configured', async () => {
    const result = await callerFor({}).getPreviewOptions({ cloudAgentSessionId: SESSION_ID });
    expect(result).toEqual({ enabled: true, hostTemplate: HOST_TEMPLATE });
  });

  it('stays off without a preview suffix', async () => {
    const caller = callerFor({ PREVIEW_HOST_SUFFIX: '' });
    await expect(caller.getPreviewOptions({ cloudAgentSessionId: SESSION_ID })).resolves.toEqual({
      enabled: false,
    });
  });
});
