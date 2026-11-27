import type { NodeOptions } from '@sentry/nextjs';
import { SENTRY_REQUEST_HEADER_ALLOWLIST } from '@kilocode/web-shared/lib/observability/sentry-request-data';

// Sentry SDK 11 collects user identity, cookies, request and response bodies,
// generative-AI content and database query data by default. Events from the web app and
// the AI gateway carry credentials and personal data in those places, so the collection
// baseline stays explicit instead of relying on the new defaults.
//
// Headers use allow lists, because a deny list misses every new name that carries a
// credential. The SDK keeps a key when its name contains an allow term, so these lists
// are a first layer: beforeSend applies the exact request header allowlist after them.
export const RESTRICTED_DATA_COLLECTION: NodeOptions['dataCollection'] = {
  userInfo: false,
  cookies: false,
  httpBodies: [],
  httpHeaders: {
    request: { allow: [...SENTRY_REQUEST_HEADER_ALLOWLIST] },
    response: { allow: ['content-type', 'content-length'] },
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
