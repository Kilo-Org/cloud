const mockSessionUpdate = jest.fn();
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    update: () => ({
      set: (values: unknown) => ({
        where: (condition: unknown) => mockSessionUpdate(values, condition),
      }),
    }),
  },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { CloudAgentPrMaintenanceAttempt, CloudAgentPrWatch } from '@kilocode/db/schema';
import { tagMaintenanceSession } from './watch-pr-maintenance-store';

it('tags a maintenance chat only when its row is not already linked to the attempt', async () => {
  await tagMaintenanceSession(
    { id: 'watch-1', kilo_user_id: 'oauth/owner' } as CloudAgentPrWatch,
    { id: 'attempt-1', session_id: 'ses_synthetic' } as CloudAgentPrMaintenanceAttempt
  );
  const [values, condition] = mockSessionUpdate.mock.calls[0];
  expect(values).toEqual({
    chat_kind: 'maintenance',
    maintenance_watch_id: 'watch-1',
    maintenance_attempt_id: 'attempt-1',
  });
  const query = new PgDialect().sqlToQuery(condition);
  expect(query.sql).toContain('"cli_sessions_v2"."chat_kind" <> $');
  expect(query.sql).toContain('"cli_sessions_v2"."maintenance_watch_id" IS DISTINCT FROM $');
  expect(query.sql).toContain('"cli_sessions_v2"."maintenance_attempt_id" IS DISTINCT FROM $');
  expect(query.params).toEqual([
    'ses_synthetic',
    'oauth/owner',
    'maintenance',
    'watch-1',
    'attempt-1',
  ]);
});
