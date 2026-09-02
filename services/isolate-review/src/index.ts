import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createErrorHandler, createNotFoundHandler, withDORetry } from '@kilocode/worker-utils';
import {
  authenticateIsolateReviewRequest,
  authenticateQueuedControl,
  isolateReviewAuthMiddleware,
  type IsolateReviewHonoEnv,
} from './auth';
import { getQueuedReviewIsolateStub, QueuedReviewRequestSchema } from './queued-review';
import { validateHeadSha, validateRepositoryName } from './git';
import { allowsDirectGithubToken } from './github-token';
import {
  preparationMatchesIdentity,
  QueuedIsolateControlRequestSchema,
  StartReviewRequestSchema,
  type StartReviewInput,
} from './types';

export { ReviewIsolate } from './review-isolate';

type HonoEnv = IsolateReviewHonoEnv;
const app = new Hono<HonoEnv>();

app.post('/queued-reviews', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async c => {
  const auth = await authenticateIsolateReviewRequest({
    internalApiKey: c.req.header('x-internal-api-key'),
    expectedInternalApiKey: c.env.INTERNAL_API_SECRET,
    authorization: c.req.header('authorization'),
    nextAuthSecret: c.env.NEXTAUTH_SECRET,
    workerEnv: c.env.ENVIRONMENT,
    connectionString: c.env.HYPERDRIVE?.connectionString,
    requirePurpose: true,
  });
  if (!auth.success) return c.json({ error: auth.error }, auth.status);
  const parsed = QueuedReviewRequestSchema.safeParse(await c.req.json<unknown>().catch(() => null));
  if (!parsed.success) return c.json({ error: 'Invalid queued review request' }, 400);
  const request = parsed.data;
  if (
    request.admission.identity.executionUserId !== auth.userId ||
    request.admission.identity.organizationId !== auth.organizationId
  ) {
    return c.json({ error: 'Queued execution identity mismatch' }, 403);
  }
  using result = await withDORetry(
    () => getQueuedReviewIsolateStub(c.env, request.admission.runId),
    stub =>
      stub.startQueuedReview(request, {
        userId: auth.userId,
        kiloToken: auth.token,
        credentialsExpireAt: auth.credentialsExpireAt,
      }),
    'startQueuedReview'
  );
  return c.json(result, 202);
});

app.post('/queued-reviews/:attemptId/control', bodyLimit({ maxSize: 16_384 }), async c => {
  const parsed = QueuedIsolateControlRequestSchema.safeParse(
    await c.req.json<unknown>().catch(() => null)
  );
  if (!parsed.success || parsed.data.identity.attemptId !== c.req.param('attemptId')) {
    return c.json({ error: 'Invalid queued review control request' }, 400);
  }
  const request = parsed.data;
  if (
    !(await authenticateQueuedControl({
      env: c.env,
      internalApiKey: c.req.header('x-internal-api-key'),
      token: c.req.header('x-isolate-control-token'),
      identity: request.identity,
      operation: request.operation,
    }))
  )
    return c.json({ error: 'Invalid queued review control authentication' }, 401);
  using result = await withDORetry(
    () => getQueuedReviewIsolateStub(c.env, request.identity.attemptId),
    stub => stub.controlQueuedReview(request),
    'controlQueuedReview'
  );
  if (!result) return c.json({ error: 'Run not found' }, 404);
  return c.json(result);
});

app.use('*', async (c, next) => {
  if (!allowsDirectGithubToken(c.env.ENVIRONMENT)) {
    return c.json({ error: 'Direct experimental reviews are development-only' }, 403);
  }
  return next();
});
app.use('*', isolateReviewAuthMiddleware);

app.post('/reviews', bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (c: Context<HonoEnv>) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json<unknown>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const parsedBody = StartReviewRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) return c.json({ error: 'Invalid review request' }, 400);
  const body = parsedBody.data;
  if (!preparationMatchesIdentity(body, c.get('userId'))) {
    return c.json({ error: 'Preparation does not match the authenticated execution user' }, 400);
  }
  if (body.dryRun === false && body.existingSummaryCommentId !== undefined && !body.previousRunId) {
    return c.json({ error: 'Summary reuse requires a previousRunId ownership proof' }, 400);
  }

  const hasDirectToken = typeof body.gitToken === 'string' && body.gitToken.trim().length > 0;
  if (hasDirectToken && !allowsDirectGithubToken(c.env.ENVIRONMENT)) {
    return c.json({ error: 'gitToken is not accepted in production' }, 400);
  }

  try {
    validateRepositoryName(body.owner, body.repo);
  } catch {
    return c.json({ error: 'owner and repo must be valid GitHub path components' }, 400);
  }

  if (body.headSha !== undefined) {
    try {
      validateHeadSha(body.headSha);
    } catch {
      return c.json({ error: 'headSha must be a full git commit SHA' }, 400);
    }
  }

  const runId = crypto.randomUUID();
  const id = c.env.REVIEW_ISOLATE.idFromName(runId);
  const input: StartReviewInput = {
    ...body,
    userId: c.get('userId'),
    kiloToken: c.get('kiloToken'),
    credentialsExpireAt: c.get('credentialsExpireAt'),
  };

  await withDORetry(
    () => c.env.REVIEW_ISOLATE.get(id),
    stub => stub.startReview(runId, input),
    'startReview'
  );

  return c.json({ runId }, 202);
});

app.get('/reviews/:runId/messages', async (c: Context<HonoEnv>) => {
  const runId = c.req.param('runId');
  if (!runId) return c.json({ error: 'runId parameter required' }, 400);
  const id = c.env.REVIEW_ISOLATE.idFromName(runId);
  using result = await withDORetry(
    () => c.env.REVIEW_ISOLATE.get(id),
    stub => stub.getTranscript(c.get('userId')),
    'getTranscript'
  );

  if (!result) return c.json({ error: 'Run not found' }, 404);
  return c.json(result);
});

app.get('/reviews/:runId', async (c: Context<HonoEnv>) => {
  const runId = c.req.param('runId');
  if (!runId) return c.json({ error: 'runId parameter required' }, 400);
  const id = c.env.REVIEW_ISOLATE.idFromName(runId);
  using result = await withDORetry(
    () => c.env.REVIEW_ISOLATE.get(id),
    stub => stub.getReview(c.get('userId')),
    'getReview'
  );

  if (!result) return c.json({ error: 'Run not found' }, 404);
  return c.json(result);
});

const handleError = createErrorHandler();
app.onError((error, c) => {
  if (error.name === 'QueuedReviewConflictError')
    return c.json({ error: 'Queued review identity or preparation conflict' }, 409);
  return handleError(error, c);
});
app.notFound(createNotFoundHandler());

export default app;
