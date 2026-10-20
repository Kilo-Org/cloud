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

const TEXT_PROPERTY_KEYS = new Set(['$elements_chain', '$el_text']);

const ELEMENT_URL_ATTRIBUTE_KEYS = new Set(['attr__href', 'attr__src', 'attr__action']);

const INITIAL_PERSON_INFO_URL_KEYS = new Set(['r', 'u']);

function isRecord(value: unknown): value is Properties {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeTextValue(value: unknown): unknown {
  return typeof value === 'string' ? sanitizeAnalyticsText(value) : value;
}

function sanitizeAttributes(attributes: Properties): Properties {
  let changed = false;
  const sanitized: Properties = { ...attributes };

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
  const sanitized: Properties = { ...element, attributes };

  for (const key of ELEMENT_URL_ATTRIBUTE_KEYS) {
    if (!(key in element)) continue;
    const value = sanitizeAnalyticsUrlValue(element[key]);
    if (value !== element[key]) {
      sanitized[key] = value;
      changed = true;
    }
  }

  for (const key of TEXT_PROPERTY_KEYS) {
    if (!(key in element)) continue;
    const value = sanitizeTextValue(element[key]);
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

function decodeValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function sanitizeMaybeEncodedUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;

  const sanitized = sanitizeAnalyticsUrlValue(value);
  if (sanitized !== value) return sanitized;

  const decoded = decodeValue(value);
  if (decoded === null || decoded === value) return value;

  const sanitizedDecoded = sanitizeAnalyticsUrlValue(decoded);
  if (sanitizedDecoded === decoded) return value;

  return encodeURIComponent(String(sanitizedDecoded));
}

function sanitizeInitialPersonInfoRecord(info: Properties): Properties {
  let changed = false;
  const sanitized: Properties = { ...info };

  for (const key of INITIAL_PERSON_INFO_URL_KEYS) {
    if (!(key in info)) continue;
    const value = sanitizeMaybeEncodedUrl(info[key]);
    if (value !== info[key]) {
      sanitized[key] = value;
      changed = true;
    }
  }

  return changed ? sanitized : info;
}

function sanitizeInitialPersonInfo(value: unknown): unknown {
  if (isRecord(value)) return sanitizeInitialPersonInfoRecord(value);
  if (typeof value !== 'string') return value;

  const decoded = decodeValue(value);
  const candidates = decoded === null || decoded === value ? [value] : [value, decoded];

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (!isRecord(parsed)) continue;
      const sanitized = sanitizeInitialPersonInfoRecord(parsed);
      if (sanitized === parsed) return value;
      const serialized = JSON.stringify(sanitized);
      return candidate === value ? serialized : encodeURIComponent(serialized);
    } catch {
      continue;
    }
  }

  return sanitizeMaybeEncodedUrl(value);
}

function sanitizePersonProperties(properties: Properties): Properties;
function sanitizePersonProperties(value: unknown): unknown;
function sanitizePersonProperties(value: unknown): unknown {
  if (!isRecord(value)) return value;

  let changed = false;
  const sanitized: Properties = { ...value };

  for (const [key, propertyValue] of Object.entries(value)) {
    const next = sanitizeProperty(key, propertyValue);
    if (next !== propertyValue) {
      sanitized[key] = next;
      changed = true;
    }
  }

  return changed ? sanitized : value;
}

function sanitizeProperty(key: string, value: unknown): unknown {
  if (URL_PROPERTY_KEYS.has(key) || key.startsWith('attr__')) {
    return sanitizeAnalyticsUrlValue(value);
  }
  if (PATH_PROPERTY_KEYS.has(key)) {
    return typeof value === 'string' ? sanitizeAnalyticsPathname(value) : value;
  }
  if (TEXT_PROPERTY_KEYS.has(key)) {
    return sanitizeTextValue(value);
  }
  if (key === '$initial_person_info') {
    return sanitizeInitialPersonInfo(value);
  }
  if (key === '$set' || key === '$set_once') {
    return sanitizePersonProperties(value);
  }
  if (key === '$elements') {
    return sanitizeElements(value);
  }
  return value;
}

function sanitizeProperties(properties: Properties): Properties {
  let changed = false;
  const sanitized: Properties = { ...properties };

  for (const [key, value] of Object.entries(properties)) {
    const next = sanitizeProperty(key, value);
    if (next !== value) {
      sanitized[key] = next;
      changed = true;
    }
  }

  return changed ? sanitized : properties;
}

export function sanitizePostHogEvent(event: null): null;
export function sanitizePostHogEvent(event: CaptureResult): CaptureResult;
export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null;
export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;

  let changed = false;
  const sanitized: CaptureResult = { ...event };

  if (event.properties) {
    const properties = sanitizeProperties(event.properties);
    if (properties !== event.properties) {
      sanitized.properties = properties;
      changed = true;
    }
  }

  if (event.$set) {
    const set = sanitizePersonProperties(event.$set);
    if (set !== event.$set) {
      sanitized.$set = set;
      changed = true;
    }
  }

  if (event.$set_once) {
    const setOnce = sanitizePersonProperties(event.$set_once);
    if (setOnce !== event.$set_once) {
      sanitized.$set_once = setOnce;
      changed = true;
    }
  }

  return changed ? sanitized : event;
}
