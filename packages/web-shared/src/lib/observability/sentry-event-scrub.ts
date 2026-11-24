// The one scrubbing policy for Sentry events, called by both the
// Node.js and edge initializers. Keep this module edge-safe: SDK imports stay
// type-only and no Node builtins are imported.

import type { Breadcrumb, Contexts, Event } from '@sentry/nextjs';
import { sanitizeSentryRequestData } from '@kilocode/web-shared/lib/observability/sentry-request-data';
import {
  FILTERED_VALUE,
  isSensitiveKey,
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
    if (isSensitiveKey(key)) {
      scrubbed[key] = FILTERED_VALUE;
    } else {
      scrubbed[key] = typeof value === 'string' ? redactSecretValues(value) : value;
    }
  }
  return scrubbed;
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.message !== undefined && { message: redactSecretValues(breadcrumb.message) }),
    ...(breadcrumb.data !== undefined && { data: scrubSecretRecord(breadcrumb.data) }),
  };
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  sanitizeSentryRequestData(event);
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
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }
  return event;
}
