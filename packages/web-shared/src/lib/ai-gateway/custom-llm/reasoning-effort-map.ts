import { ReasoningEffortSchema, type ReasoningEffortMap } from '@kilocode/db/schema-types';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';

function mapEffortField(container: unknown, key: string, map: ReasoningEffortMap) {
  if (!isRecord(container)) return;
  const effort = ReasoningEffortSchema.safeParse(container[key]);
  if (!effort.success) return;
  const mapped = map[effort.data];
  if (mapped !== undefined) container[key] = mapped;
}

/** Rewrites the reasoning efforts the request carries for its API kind; see `ReasoningEffortMapSchema`. */
export function applyReasoningEffortMap(
  request: GatewayRequest,
  map: ReasoningEffortMap | undefined
) {
  if (!map) return;
  const body = request.body as Record<string, unknown>;
  switch (request.kind) {
    case 'chat_completions':
      mapEffortField(body.reasoning, 'effort', map);
      mapEffortField(body, 'reasoning_effort', map);
      break;
    case 'responses':
      mapEffortField(body.reasoning, 'effort', map);
      break;
    case 'messages':
      mapEffortField(body.output_config, 'effort', map);
      break;
  }
}

/**
 * The request as the upstream receives it after `applyReasoningEffortMap`, leaving the request
 * itself untouched. Only the objects the map can rewrite are copied.
 */
export function withReasoningEffortMap(
  request: GatewayRequest,
  map: ReasoningEffortMap | undefined
): GatewayRequest {
  if (!map) return request;
  const body: Record<string, unknown> = { ...request.body };
  for (const key of ['reasoning', 'output_config']) {
    const value = body[key];
    if (isRecord(value)) body[key] = { ...value };
  }
  const copy = { kind: request.kind, body } as GatewayRequest;
  applyReasoningEffortMap(copy, map);
  return copy;
}
