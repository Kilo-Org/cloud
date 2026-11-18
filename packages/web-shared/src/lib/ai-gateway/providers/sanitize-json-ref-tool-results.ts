import { isRecord } from '@kilocode/web-shared/lib/ai-gateway/providers/json-schema-traversal';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * Same order as `CACHE_CONTROL_NODE_BUDGET` in the OpenRouter request helpers: tool payloads
 * are client-supplied, so a traversal of one needs a fixed bound. A payload over either
 * budget is left unchanged rather than partially rewritten.
 */
const JSON_REF_NODE_BUDGET = 100_000;

/** Same value as `PROMPT_WALK_MAX_DEPTH` in `packages/auto-routing-contracts/src/normalize.ts`. */
const JSON_REF_MAX_DEPTH = 64;

/**
 * Renames `$ref` properties to `_ref` in place and reports whether anything would change.
 * The walk is iterative with a node and a depth budget, and it renames only after it has
 * finished inside both budgets, so an over-budget payload is returned untouched.
 */
function renameJsonRefProperties(value: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const refOwners: Array<Record<string, unknown>> = [];
  let visited = 0;
  while (pending.length > 0) {
    if (visited >= JSON_REF_NODE_BUDGET) {
      return false;
    }
    const frame = pending.pop();
    if (frame === undefined) {
      return false;
    }
    visited += 1;
    const current = frame.value;
    let children: readonly unknown[];
    if (Array.isArray(current)) {
      children = current;
    } else if (isRecord(current)) {
      if (Object.hasOwn(current, '$ref')) {
        refOwners.push(current);
      }
      children = Object.values(current);
    } else {
      continue;
    }
    if (children.length > 0 && frame.depth >= JSON_REF_MAX_DEPTH) {
      return false;
    }
    if (visited + pending.length + children.length > JSON_REF_NODE_BUDGET) {
      return false;
    }
    for (const child of children) {
      pending.push({ value: child, depth: frame.depth + 1 });
    }
  }
  for (const owner of refOwners) {
    const ref = owner.$ref;
    delete owner.$ref;
    owner._ref = ref;
  }
  return refOwners.length > 0;
}

function sanitizeJsonRefContent(content: string): string {
  // Content that cannot contain the property this transform targets needs no parse and no
  // re-serialization, which is the common case for replayed tool history.
  if (!content.includes('$ref')) {
    return content;
  }
  try {
    const result: unknown = JSON.parse(content);
    return renameJsonRefProperties(result) ? JSON.stringify(result) : content;
  } catch {
    return content;
  }
}

export function sanitizeJsonRefToolResults(request: GatewayRequest) {
  if (request.kind !== 'chat_completions') {
    return;
  }

  for (const message of request.body.messages) {
    if (message.role !== 'tool') {
      continue;
    }

    if (typeof message.content === 'string') {
      message.content = sanitizeJsonRefContent(message.content);
    } else {
      for (const part of message.content) {
        if (part.type === 'text') {
          part.text = sanitizeJsonRefContent(part.text);
        }
      }
    }
  }
}
