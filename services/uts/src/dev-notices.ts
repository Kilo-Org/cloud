import { UTS_SECURITY_PATH } from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { Env } from './env';
import { NOTICE_ATTEMPT_OUTCOMES } from './db/enums';
import { credentialNotices } from './notices/credential';
import { type NoticeDeps, dispatchNotice, sweepNotices } from './notices/dispatch';
import { type FakeAnswers, type RecordedMessage, fakeTransports } from './notices/fake-transports';
import { handleSecurityRequest, replicaSecurityView } from './notices/security-view';
import { noticesAccess } from './notices/store';
import { jsonResponse } from './responses';

/**
 * Development-only notice routes for the local end-to-end run; only `src/dev.ts` reaches this
 * module (see there). Push and email go to fake transports that send nothing and keep each message
 * in this isolate's memory, which `GET /__dev/notices/outbox` returns.
 *
 * * `POST /__dev/notices/dispatch` `{ "noticeId" }` claims and delivers one notice.
 * * `POST /__dev/notices/credential` `{ "kind", "accountId", "credentialId" }` runs the account
 *   API's credential notice port.
 * * `POST /__dev/notices/sweep` runs one background pass.
 * * `Kilo-Dev-Notice-Answers: push=no_target,email=retryable_failure` picks what the fake
 *   transports answer for that request (default `sent` on both).
 * * `GET /account/security` serves the security view with a development caller check: the
 *   `Kilo-Dev-Account` and `Kilo-Dev-Grant` headers name the caller, and the view statement still
 *   checks that the grant and its session are live.
 */

export const DEV_NOTICES_PATH = '/__dev/notices';

const outbox: RecordedMessage[] = [];

const Outcome = z.enum(NOTICE_ATTEMPT_OUTCOMES);
const AnswersSchema = z
  .string()
  .regex(/^(push|email)=[a-z_]+(,(push|email)=[a-z_]+)?$/)
  .transform(header =>
    Object.fromEntries(
      header.split(',').map((pair): [string, string] => {
        const [channel = '', outcome = ''] = pair.split('=');
        return [channel, outcome];
      })
    )
  )
  .pipe(z.strictObject({ push: Outcome.optional(), email: Outcome.optional() }));

function answersOf(request: Request): FakeAnswers | Response {
  const header = request.headers.get('Kilo-Dev-Notice-Answers');
  if (header === null) return { push: () => 'sent', email: () => 'sent' };
  const parsed = AnswersSchema.safeParse(header);
  if (!parsed.success) return jsonResponse({ error: 'invalid_request' }, 400);
  const { push = 'sent', email = 'sent' } = parsed.data;
  return { push: () => push, email: () => email };
}

const DispatchSchema = z.strictObject({ noticeId: z.uuid() });
const CredentialSchema = z.strictObject({
  kind: z.enum(['pat_created', 'bot_key_created']),
  accountId: z.string().min(1),
  credentialId: z.uuid(),
});
const DevCallerSchema = z.object({ accountId: z.string().min(1), grantId: z.uuid() });

export async function handleDevNoticeRequest(
  request: Request,
  pathname: string,
  env: Env,
  ctx: ExecutionContext
): Promise<Response | null> {
  if (pathname === UTS_SECURITY_PATH) {
    if (env.IDENTITY_STORE_REPLICA === undefined) return null;
    return await handleSecurityRequest(request, pathname, {
      authenticate: async incoming => {
        const caller = DevCallerSchema.safeParse({
          accountId: incoming.headers.get('Kilo-Dev-Account'),
          grantId: incoming.headers.get('Kilo-Dev-Grant'),
        });
        return caller.success
          ? { status: 'ok', caller: caller.data }
          : { status: 'refused', response: jsonResponse({ error: 'invalid_token' }, 401) };
      },
      read: replicaSecurityView(env.IDENTITY_STORE_REPLICA.connectionString, ctx),
    });
  }
  if (!pathname.startsWith(`${DEV_NOTICES_PATH}/`)) return null;
  if (pathname === `${DEV_NOTICES_PATH}/outbox`) return jsonResponse({ messages: outbox }, 200);
  if (env.IDENTITY_STORE === undefined) return null;
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }
  const answers = answersOf(request);
  if (answers instanceof Response) return answers;
  const input: unknown = await request.json().catch(() => undefined);
  const deps: NoticeDeps = {
    notices: noticesAccess(env.IDENTITY_STORE.connectionString, ctx),
    transports: fakeTransports(answers, outbox),
    now: () => new Date(),
  };
  switch (pathname.slice(DEV_NOTICES_PATH.length)) {
    case '/dispatch': {
      const parsed = DispatchSchema.safeParse(input);
      if (!parsed.success) return jsonResponse({ error: 'invalid_request' }, 400);
      return jsonResponse({ result: await dispatchNotice(deps, parsed.data.noticeId) }, 200);
    }
    case '/credential': {
      const parsed = CredentialSchema.safeParse(input);
      if (!parsed.success) return jsonResponse({ error: 'invalid_request' }, 400);
      await credentialNotices(deps)(parsed.data);
      return jsonResponse({ ok: true }, 200);
    }
    case '/sweep':
      return jsonResponse({ result: await sweepNotices(deps) }, 200);
    default:
      return null;
  }
}
