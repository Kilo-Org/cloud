import {
  EnkryptUsageWriteSchema,
  ExaUsageRecordSchema,
  UsageRecordRequestSchema,
} from '@kilocode/usage-contracts';

type ValidationError = Extract<
  ReturnType<typeof UsageRecordRequestSchema.safeParse>,
  { success: false }
>['error'];

type FlatRecordValidationError = { issues: { path: PropertyKey[]; code: string }[] };

const MAX_ISSUES = 8;
const MAX_PATH_DEPTH = 4;

// Only schema-owned paths may cross the logging boundary. In particular, do not
// extend this list with keys from bouncer_usage_event.payload's arbitrary record.
const fieldsByParent: Readonly<Record<string, readonly string[]>> = {
  '': ['core', 'metadata', 'prior_microdollar_usage', 'posthog_distinct_id', 'bouncer_usage_event'],
  core: [
    'id',
    'kilo_user_id',
    'cost',
    'input_tokens',
    'output_tokens',
    'cache_write_tokens',
    'cache_hit_tokens',
    'created_at',
    'provider',
    'model',
    'requested_model',
    'cache_discount',
    'has_error',
    'abuse_classification',
    'organization_id',
    'inference_provider',
    'project_id',
  ],
  metadata: [
    'id',
    'message_id',
    'created_at',
    'http_x_forwarded_for',
    'http_x_vercel_ip_city',
    'http_x_vercel_ip_country',
    'http_x_vercel_ip_latitude',
    'http_x_vercel_ip_longitude',
    'http_x_vercel_ja4_digest',
    'user_prompt_prefix',
    'system_prompt_prefix',
    'system_prompt_length',
    'http_user_agent',
    'max_tokens',
    'has_middle_out_transform',
    'status_code',
    'upstream_id',
    'finish_reason',
    'latency',
    'moderation_latency',
    'generation_time',
    'is_byok',
    'is_user_byok',
    'streamed',
    'cancelled',
    'editor_name',
    'api_kind',
    'has_tools',
    'machine_id',
    'feature',
    'session_id',
    'mode',
    'auto_model',
    'reasoning_setting',
    'inference_region',
    'market_cost',
    'non_inference_cost',
    'is_free',
    'abuse_delay',
    'abuse_downgraded_from',
  ],
  bouncer_usage_event: ['request_id', 'payload'],
};

function safePath(path: PropertyKey[]): string[] {
  const output: string[] = [];
  let parent = '';
  for (const segment of path.slice(0, MAX_PATH_DEPTH)) {
    if (typeof segment !== 'string' || !fieldsByParent[parent]?.includes(segment)) {
      output.push('[redacted]');
      break;
    }
    output.push(segment);
    parent = output.join('.');
  }
  return output;
}

// Called only on JSON.parse output, never on a Request or a validator's input.
function ownValue(value: unknown, path: PropertyKey[]): unknown {
  if (path.length > MAX_PATH_DEPTH) return undefined;
  for (const segment of path) {
    if (value === null || typeof value !== 'object') return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, segment);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
    value = descriptor.value;
  }
  return value;
}

function receivedType(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'number':
      return 'number';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'unknown';
  }
}

function expectedType(issue: ValidationError['issues'][number]): string {
  const label =
    issue.code === 'invalid_type'
      ? issue.expected
      : issue.code === 'invalid_format'
        ? 'string'
        : issue.code === 'too_big' || issue.code === 'too_small'
          ? issue.origin
          : 'unknown';
  switch (label) {
    case 'int':
      return 'integer';
    case 'number':
    case 'string':
    case 'boolean':
    case 'null':
    case 'object':
    case 'array':
      return label;
    default:
      return 'unknown';
  }
}

function issueCode(code: string): string {
  switch (code) {
    case 'invalid_type':
    case 'too_big':
    case 'too_small':
    case 'invalid_format':
    case 'not_multiple_of':
    case 'unrecognized_keys':
    case 'invalid_union':
    case 'invalid_key':
    case 'invalid_element':
    case 'invalid_value':
    case 'custom':
      return code;
    default:
      return 'unknown';
  }
}

export function schemaRejectionDetails(error: ValidationError, parsedJson: unknown): object {
  const id = UsageRecordRequestSchema.shape.core.shape.id.safeParse(
    ownValue(parsedJson, ['core', 'id'])
  );
  return {
    ...(id.success ? { usage_id: id.data } : {}),
    issues: error.issues.slice(0, MAX_ISSUES).map(issue => ({
      code: issueCode(issue.code),
      path: safePath(issue.path),
      expected_type: expectedType(issue),
      received_type:
        issue.path.length > MAX_PATH_DEPTH
          ? 'unknown'
          : receivedType(ownValue(parsedJson, issue.path)),
    })),
    omitted_issue_count: Math.max(0, error.issues.length - MAX_ISSUES),
  };
}

/** A flat record names only a top-level schema key; deeper segments are redacted. */
function flatRecordPath(fields: readonly string[], path: PropertyKey[]): string[] {
  const [field, ...rest] = path;
  if (field === undefined) return [];
  if (typeof field !== 'string' || !fields.includes(field)) return ['[redacted]'];
  return rest.length === 0 ? [field] : [field, '[redacted]'];
}

function flatRecordRejectionDetails(
  fields: readonly string[],
  error: FlatRecordValidationError
): object {
  return {
    issues: error.issues.slice(0, MAX_ISSUES).map(issue => ({
      code: issueCode(issue.code),
      path: flatRecordPath(fields, issue.path),
    })),
    omitted_issue_count: Math.max(0, error.issues.length - MAX_ISSUES),
  };
}

const enkryptFields: readonly string[] = Object.keys(EnkryptUsageWriteSchema.shape);
const exaFields: readonly string[] = Object.keys(ExaUsageRecordSchema.shape);

export function enkryptSchemaRejectionDetails(error: FlatRecordValidationError): object {
  return flatRecordRejectionDetails(enkryptFields, error);
}

export function exaSchemaRejectionDetails(error: FlatRecordValidationError): object {
  return flatRecordRejectionDetails(exaFields, error);
}
