/**
 * The message the server puts on a Slack disconnect it could not confirm
 * (`apps/web/src/lib/integrations/slack-service.ts` `uninstallApp`).
 *
 * The tRPC wire carries only the error code and message, so this string is the
 * one signal a client has for "Slack did not answer, the integration is still
 * connected, try again" — `SERVICE_UNAVAILABLE` also covers other outages. It
 * must stay identical on both sides, which is why it lives here.
 */
export const SLACK_DISCONNECT_UNCONFIRMED_MESSAGE =
  'Slack could not confirm the disconnect. Try again.';
