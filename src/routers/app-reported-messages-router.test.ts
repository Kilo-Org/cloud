import { app_reported_messages } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { generateMessageSignature } from '@/lib/app-reported-messages/messageSignature';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import type { User } from '@kilocode/db/schema';

let user: User;

describe('app-reported-messages-router', () => {
  beforeAll(async () => {
    user = await insertTestUser({
      google_user_email: 'app-reported-messages@example.com',
      google_user_name: 'App Reported Messages User',
      is_admin: false,
    });
  });

  it('creates a row and returns report_id', async () => {
    const caller = await createCallerForUser(user.id);

    const message = { foo: 'bar', answer: 42 };
    const result = await caller.appReportedMessages.createReport({
      report_type: 'unparsed',
      message,
      cli_session_id: null,
      mode: 'code',
      model: 'openai/gpt-4.1',
    });

    expect(result).toEqual({ report_id: expect.any(String) });

    const [row] = await db
      .select()
      .from(app_reported_messages)
      .where(eq(app_reported_messages.report_id, result.report_id));

    expect(row).toBeDefined();
    expect(row.report_type).toBe('unparsed');
    expect(row.message).toEqual(message);

    await db
      .delete(app_reported_messages)
      .where(eq(app_reported_messages.report_id, result.report_id));
  });

  it('persists signature computed from message (including nested JSON strings)', async () => {
    const caller = await createCallerForUser(user.id);

    const message = {
      payload: JSON.stringify({
        a: 1,
        b: '2',
        c: JSON.stringify({ ok: 'true', inner: JSON.stringify({ z: null }) }),
      }),
      notJson: '{ bad json }',
    };

    const expectedSignature = generateMessageSignature(message);
    const result = await caller.appReportedMessages.createReport({
      report_type: 'unstyled',
      message,
      cli_session_id: null,
      mode: 'ask',
      model: 'anthropic/claude-sonnet-4',
    });

    const [row] = await db
      .select({ signature: app_reported_messages.signature })
      .from(app_reported_messages)
      .where(eq(app_reported_messages.report_id, result.report_id));

    expect(row).toBeDefined();
    expect(row.signature).toEqual(expectedSignature);

    await db
      .delete(app_reported_messages)
      .where(eq(app_reported_messages.report_id, result.report_id));
  });

  it('supports cli_session_id null and mode/model null', async () => {
    const caller = await createCallerForUser(user.id);

    const message = { a: 'b' };
    const result = await caller.appReportedMessages.createReport({
      report_type: 'unparsed',
      message,
      cli_session_id: null,
      mode: null,
      model: null,
    });

    const [row] = await db
      .select({
        cli_session_id: app_reported_messages.cli_session_id,
        mode: app_reported_messages.mode,
        model: app_reported_messages.model,
      })
      .from(app_reported_messages)
      .where(eq(app_reported_messages.report_id, result.report_id));

    expect(row).toBeDefined();
    expect(row.cli_session_id).toBeNull();
    expect(row.mode).toBeNull();
    expect(row.model).toBeNull();

    await db
      .delete(app_reported_messages)
      .where(eq(app_reported_messages.report_id, result.report_id));
  });
});
