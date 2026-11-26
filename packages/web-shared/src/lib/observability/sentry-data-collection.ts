import type { NodeOptions } from '@sentry/nextjs';

// Sentry SDK 11 collects user identity, cookies, request and response bodies,
// generative-AI content and database query data by default. Events from the web app and
// the AI gateway carry credentials and personal data in those places, so the collection
// baseline stays explicit instead of relying on the new defaults.
//
// The deny terms extend the built-in sensitive-value denylist to the values that
// identify a user without being credentials: forwarding headers, remote addresses,
// and user ids.
const SENSITIVE_KEY_DENYLIST = { deny: ['forwarded', '-ip', 'remote-', 'via', '-user'] };

export const RESTRICTED_DATA_COLLECTION: NodeOptions['dataCollection'] = {
  userInfo: false,
  cookies: false,
  httpBodies: [],
  httpHeaders: {
    request: SENSITIVE_KEY_DENYLIST,
    response: SENSITIVE_KEY_DENYLIST,
  },
  // Query keys stay visible, but the SDK filters every value: a value can hold a
  // nested URL or a token (callbackPath, a tRPC input), and the SDK applies this
  // policy to request URLs, the Next.js request path and outgoing request
  // breadcrumbs before beforeSend runs.
  urlQueryParams: { allow: [] },
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
};
