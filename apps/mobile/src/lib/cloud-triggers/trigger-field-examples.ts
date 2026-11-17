/**
 * Example values the trigger form shows in technical fields.
 *
 * A cron expression, a time-zone identifier, an agent slug, a header name and a
 * JSON body schema are not copy: no catalog translates them, and a translated
 * one would name something the server refuses. They live in one record so the
 * screens do not spell them in JSX.
 */
export const TRIGGER_FIELD_EXAMPLES = {
  cron: '0 9 * * 1-5',
  timeZone: 'UTC',
  agent: 'foreman',
  authHeader: 'x-webhook-secret',
  bodySchema: '{\n  "type": "object"\n}',
} as const;
