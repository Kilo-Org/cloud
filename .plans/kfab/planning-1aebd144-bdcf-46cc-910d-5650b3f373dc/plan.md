<!-- kfab-plan schema=1 -->
# Implementation plan

## Change title

Reject non-array assistant tool_calls on chat completions with a 400 and guard deduplicateToolUses

## Problem

POST /api/v1/chat/completions on the AI gateway returns an unhandled 500 (TypeError: e.tool_calls.filter is not a function) when a client sends an assistant message whose tool_calls is truthy but not an array. The gateway never checks the shape of tool_calls inside each message. deduplicateToolUses in packages/web-shared/src/lib/ai-gateway/tool-calling.ts only checks that tool_calls is truthy before calling .filter, and repairChatCompletionsTools runs it on every chat_completions request.

## Evidence

- Sentry KILOCODE-WEB-28H2 (anaconda-nq/kilocode-web, issue 7815340638): TypeError 'e.tool_calls.filter is not a function', transaction POST /api/v1/[...path], URL ai-gateway.kilo.ai/api/v1/chat/completions, handled=no (mechanism auto.function.nextjs.on_request_error), 2 events on 2026-10-27 between 19:10 and 19:18 UTC, 0 users, client curl, model openrouter/free, release 8ba777a4. The stack frames are minified, so they do not name the source line.
- Sentry KILOCODE-WEB-27ST (from triage): same error title on the older /api/gateway route, 25 events from 2026-08-27 to 2026-08-29. Its resolved frame is the statement 'assistantMessage.tool_calls = assistantMessage.tool_calls.filter(...)' in tool-calling.ts deduplicateToolUses, reached through applyProviderSpecificLogic -> repairChatCompletionsTools.
- Pinned tool-calling.ts lines 132-148: deduplicateToolUses checks only `if (!assistantMessage.tool_calls) return;` and then calls `.filter`. In repairChatCompletionsTools, the loop `for (const toolCall of group.assistantMessage?.tool_calls ?? [])` would also walk a string one character at a time and insert bogus tool results. normalizeChatCompletionsToolCallIds and sanitizeChatCompletionsToolResults likewise iterate `msg.tool_calls ?? []` without checking for an array.
- apply-provider-specific-logic.ts:353 calls repairChatCompletionsTools unconditionally for chat_completions. Line 98 (mapGeminiReasoningDetails) already uses `Array.isArray(message.tool_calls) ? ... : []`, which shows a non-array tool_calls is treated as possible client input.
- llm-proxy.ts:315-318 validates only that messages is an array (returning invalidRequestResponse() 400) and never looks at tool_calls inside each message. invalidRequestResponse in llm-proxy-helpers.ts:86 returns 400 with error_type invalid_request, but its message says 'Could not parse request body', which is misleading for a shape error.

## Desired outcome

A chat completions request with a non-array tool_calls on any assistant message fails fast with a specific 400 invalid_request response instead of an unhandled 500, and nothing is sent upstream. The tool-repair helpers no longer throw on, or corrupt, a non-array tool_calls if one ever reaches them. Requests with a valid tool_calls (array, missing, or null) behave exactly as before.

## Scope

- In llm-proxy.ts, add per-message validation for chat_completions requests, right after the existing check that messages is an array: if any message has role 'assistant' and a tool_calls that is not null/undefined and not an array, return a 400 with error_type invalid_request and a specific message such as 'messages[i].tool_calls must be an array'. Reuse the existing response helpers, or add a small one beside invalidRequestResponse.
- Defense in depth in tool-calling.ts: deduplicateToolUses returns early unless Array.isArray(assistantMessage.tool_calls). The missing-results loop in repairChatCompletionsTools only iterates when tool_calls is an array. Mirror this with the same Array.isArray guard in normalizeChatCompletionsToolCallIds and sanitizeChatCompletionsToolResults.
- Regression tests in tool-calling.test.ts (repairChatCompletionsTools with string and object tool_calls) and in llm-proxy.test.ts (a non-array tool_calls returns 400 invalid_request and does not call upstream).

## Exclusions

- Full schema validation of chat completions messages or of the individual tool-call objects (for example, missing id or function fields).
- Changing the generic wording of invalidRequestResponse for other callers.
- Validating messages-format or responses-format requests. Those paths already guard with Array.isArray.
- Changing the free-model or curl client handling.

## Approach

- Validate at the boundary: in llm-proxy.ts, inside the existing `kind === 'chat_completions' || 'messages'` block (or a chat_completions-only block right after it), loop over body.messages. For a record message with role === 'assistant' and `tool_calls != null && !Array.isArray(tool_calls)`, return a 400 invalid_request whose message names the bad field. Do not inspect non-record messages here, to keep the scope narrow.
- Harden the helpers: in tool-calling.ts, replace the truthiness check in deduplicateToolUses with `if (!Array.isArray(assistantMessage.tool_calls)) return;`, the same pattern deduplicateMessagesToolUses uses. Change the `?? []` iterations over chat tool_calls (in repairChatCompletionsTools, normalizeChatCompletionsToolCallIds, and sanitizeChatCompletionsToolResults) to iterate only when the value is an array, so non-array input is left as-is rather than walked character by character or written to.
- Add the unit tests: (a) repairChatCompletionsTools with an assistant message whose tool_calls is a string, and another whose tool_calls is an object, does not throw and does not insert synthetic tool results; (b) the llm-proxy handler with such a body returns status 400 with error_type invalid_request and makes no upstream fetch; (c) the existing duplicate-tool-call tests still pass unchanged.

## Affected areas

- packages/web-shared/src/lib/ai-gateway/handlers/llm-proxy.ts (request body validation)
- packages/web-shared/src/lib/ai-gateway/tool-calling.ts (deduplicateToolUses, repairChatCompletionsTools, normalizeChatCompletionsToolCallIds, sanitizeChatCompletionsToolResults)
- packages/web-shared/src/lib/ai-gateway/tool-calling.test.ts
- packages/web-shared/src/lib/ai-gateway/handlers/llm-proxy.test.ts

## Acceptance criteria

### ac-1: A POST to the chat completions proxy where an assistant message's tool_calls is a non-null non-array value (string or object) returns HTTP 400 with error_type invalid_request and a message naming the bad tool_calls field. No upstream request is made and no unhandled exception is thrown. A test in llm-proxy.test.ts covers both the string and the object case.

**Verification:** Code review

### ac-2: repairChatCompletionsTools, called directly on a request whose assistant message has a string or object tool_calls, does not throw and does not insert synthetic 'Tool execution was interrupted' tool results for that message. normalizeChatCompletionsToolCallIds and sanitizeChatCompletionsToolResults also do not throw on such input. Covered by new tests in tool-calling.test.ts.

**Verification:** Code review

### ac-3: No change for valid requests: assistant messages whose tool_calls is an array, missing, or null go through deduplication, missing-result insertion, and orphan removal exactly as before. The existing repairChatCompletionsTools tests and the llm-proxy chat completions tests pass without modification.

**Verification:** Code review

### ac-4: After deployment, Sentry KILOCODE-WEB-28H2 and KILOCODE-WEB-27ST record no new 'tool_calls.filter is not a function' events. Malformed callers instead receive a 400 right away, with no added latency.

**Verification:** Manual: Observe Sentry issues KILOCODE-WEB-28H2 / KILOCODE-WEB-27ST after the release containing the fix and confirm no new events

## Risks

- Some existing client might send a non-array tool_calls that has worked so far. That is unlikely: any truthy non-array value already 500s in deduplicateToolUses, and an array-like object would fail as non-iterable earlier. So the 400 only replaces requests that already fail.
- If the validation also rejected `tool_calls: null`, it could break valid OpenAI-style histories. The check must treat null and undefined as absent.
- The test command for web-shared tests is not established from the pinned config, because packages/web-shared/package.json declares only a typecheck script. The implementer should find the runner through the repository-verification skill.

## Assumptions

- The failing input is a client-supplied assistant message with a non-array tool_calls. The exact payload is not visible in Sentry, but the fix works for any non-array value.
- The minified deployed code at release 8ba777a4 matches the pinned tool-calling.ts at the failing statement, as KILOCODE-WEB-27ST's resolved frame confirms.

## Decisions

### d-1: Should malformed tool_calls be silently ignored or rejected?

**Answer:** Reject with a specific 400 at the request boundary, following the repository's Failure UX guidance to fail fast with a correct reason. Also keep Array.isArray guards in the helpers as defense in depth so they never throw or corrupt messages.

**Blocking:** no
