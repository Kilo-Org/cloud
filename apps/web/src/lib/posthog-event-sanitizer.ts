import type { CaptureResult, Properties } from 'posthog-js';
import {
  sanitizeAnalyticsPathname,
  sanitizeAnalyticsText,
  sanitizeAnalyticsUrlValue,
} from '@kilocode/web-shared/lib/sanitize-analytics-url';

const URL_PROPERTY_KEYS = new Set([
  '$current_url',
  '$referrer',
  '$referring_domain',
  '$initial_current_url',
  '$initial_referrer',
  '$initial_referring_domain',
  '$session_entry_url',
  '$session_entry_referrer',
  '$session_entry_referring_domain',
  '$external_click_url',
]);

const PATH_PROPERTY_KEYS = new Set([
  '$pathname',
  '$initial_pathname',
  '$session_entry_pathname',
  '$prev_pageview_pathname',
]);

const TEXT_PROPERTY_KEYS = new Set(['$elements_chain']);

const ELEMENT_URL_ATTRIBUTE_KEYS = new Set(['attr__href', 'attr__src', 'attr__action']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const sanitized: Record<string, unknown> = { ...attributes };

  for (const key of ELEMENT_URL_ATTRIBUTE_KEYS) {
    if (!(key in attributes)) continue;
    const value = sanitizeAnalyticsUrlValue(attributes[key]);
    if (value !== attributes[key]) {
      sanitized[key] = value;
      changed = true;
    }
  }

  return changed ? sanitized : attributes;
}

function sanitizeElement(element: unknown): unknown {
  if (!isRecord(element)) return element;

  const attributes = isRecord(element.attributes)
    ? sanitizeAttributes(element.attributes)
    : element.attributes;

  let changed = attributes !== element.attributes;
  const sanitized: Record<string, unknown> = { ...element, attributes };

  for (const key of ELEMENT_URL_ATTRIBUTE_KEYS) {
    if (!(key in element)) continue;
    const value = sanitizeAnalyticsUrlValue(element[key]);
    if (value !== element[key]) {
      sanitized[key] = value;
      changed = true;
    }
  }

  return changed ? sanitized : element;
}

function sanitizeElements(elements: unknown): unknown {
  if (!Array.isArray(elements)) return elements;
  return elements.map(sanitizeElement);
}

function sanitizeProperty(key: string, value: unknown): unknown {
  if (URL_PROPERTY_KEYS.has(key) || key.startsWith('attr__')) {
    return sanitizeAnalyticsUrlValue(value);
  }
  if (PATH_PROPERTY_KEYS.has(key)) {
    return typeof value === 'string' ? sanitizeAnalyticsPathname(value) : value;
  }
  if (TEXT_PROPERTY_KEYS.has(key)) {
    return typeof value === 'string' ? sanitizeAnalyticsText(value) : value;
  }
  if (key === '$elements') {
    return sanitizeElements(value);
  }
  return value;
}

export function sanitizePostHogEvent(event: null): null;
export function sanitizePostHogEvent(event: CaptureResult): CaptureResult;
export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null;
export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event?.properties) return event;

  let changed = false;
  const properties: Properties = { ...event.properties };

  for (const [key, value] of Object.entries(event.properties)) {
    const sanitized = sanitizeProperty(key, value);
    if (sanitized !== value) {
      properties[key] = sanitized;
      changed = true;
    }
  }

  return changed ? { ...event, properties } : event;
}
