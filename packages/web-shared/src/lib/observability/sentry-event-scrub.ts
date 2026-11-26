// The one scrubbing policy for Sentry events and breadcrumbs, called by both the
// Node.js and edge initializers. Keep this module edge-safe: SDK imports stay
// type-only and no Node builtins are imported.

import type { Breadcrumb, Contexts, Event } from '@sentry/nextjs';
import { sanitizeSentryRequestData } from '@kilocode/web-shared/lib/observability/sentry-request-data';
import {
  FILTERED_VALUE,
  isSensitiveEntry,
  redactSecretValues,
  scrubSecretRecord,
  scrubSecrets,
} from '@kilocode/web-shared/lib/observability/sentry-secret-patterns';

function scrubContexts(contexts: Contexts): Contexts {
  const scrubbed: Contexts = {};
  for (const [name, context] of Object.entries(contexts)) {
    scrubbed[name] = context && scrubSecretRecord(context);
  }
  return scrubbed;
}

function scrubTags(tags: NonNullable<Event['tags']>): NonNullable<Event['tags']> {
  const scrubbed: NonNullable<Event['tags']> = {};
  for (const [key, value] of Object.entries(tags)) {
    if (isSensitiveEntry(key, value)) {
      scrubbed[key] = FILTERED_VALUE;
    } else {
      scrubbed[key] = typeof value === 'string' ? redactSecretValues(value) : value;
    }
  }
  return scrubbed;
}

// Console breadcrumbs hold formatted console text, which can carry a secret that
// no pattern matches, so they are dropped like console logs.
function isConsoleBreadcrumb(breadcrumb: Breadcrumb): boolean {
  return breadcrumb.category === 'console';
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb | null {
  return isConsoleBreadcrumb(breadcrumb) ? null : scrubBreadcrumb(breadcrumb);
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.message !== undefined && { message: redactSecretValues(breadcrumb.message) }),
    ...(breadcrumb.data !== undefined && { data: scrubSecretRecord(breadcrumb.data) }),
  };
}

// The SDK copies the root span name into the trace header of every envelope and
// into the baggage header of outgoing requests. Neither path runs beforeSend, and
// a span name can hold a URL. Tracing is off, so no sampling decision reads it.
export function dropTraceTransactionName(dsc: { transaction?: string }): void {
  delete dsc.transaction;
}

// The request policy keeps the URL path and the allowed header values. A path
// can hold a capability token and a kept query value can hold a credential, so
// those values get the free-text scrub too. The referer keeps its origin and
// path only, because its query belongs to another page.
function scrubRequest(request: NonNullable<Event['request']>): void {
  if (typeof request.url === 'string') {
    request.url = redactSecretValues(request.url);
  }
  const headers = request.headers;
  if (!headers) {
    return;
  }
  for (const [name, value] of Object.entries(headers)) {
    const scrubbed = redactSecretValues(value);
    headers[name] =
      name.toLowerCase() === 'referer' ? (scrubbed.split(/[?#]/, 1)[0] ?? '') : scrubbed;
  }
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  sanitizeSentryRequestData(event);
  delete event.request?.env;
  if (event.request) {
    scrubRequest(event.request);
  }
  // Sentry also shows the transaction name as the `transaction` tag.
  if (event.transaction !== undefined) {
    event.transaction = redactSecretValues(event.transaction);
  }
  if (event.message !== undefined) {
    event.message = redactSecretValues(event.message);
  }
  if (event.logentry) {
    if (event.logentry.message !== undefined) {
      event.logentry.message = redactSecretValues(event.logentry.message);
    }
    if (event.logentry.params) {
      event.logentry.params = event.logentry.params.map(scrubSecrets);
    }
  }
  for (const exception of event.exception?.values ?? []) {
    if (exception.value !== undefined) {
      exception.value = redactSecretValues(exception.value);
    }
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }
  if (event.fingerprint) {
    event.fingerprint = event.fingerprint.map(entry => redactSecretValues(entry));
  }
  if (event.user) {
    const id = event.user.id;
    if (id === undefined) {
      delete event.user;
    } else {
      event.user = { id };
    }
  }
  if (event.extra) {
    event.extra = scrubSecretRecord(event.extra);
  }
  if (event.contexts) {
    event.contexts = scrubContexts(event.contexts);
  }
  if (event.tags) {
    event.tags = scrubTags(event.tags);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter(breadcrumb => !isConsoleBreadcrumb(breadcrumb))
      .map(scrubBreadcrumb);
  }
  return event;
}
