# Enkrypt AI guardrails and the AI Gateway: integration ideas

Candidate integrations between [Enkrypt AI](https://docs.enkryptai.com/home/introduction) and the
AI Gateway chat endpoints (`/chat/completions`, `/messages`, `/responses`). This is an exploration
document, not a committed design.

## Current state

- The gateway has no content-level guardrail hook. The only request-side block is the Bouncer
  verdict (`packages/web-shared/src/lib/bouncer/inference.ts`), which judges request metadata, not
  message content.
- The only Enkrypt integration today ingests Enkrypt leaderboard scores into the model catalog
  (`packages/web-shared/src/lib/model-stats/enkrypt*`, [Enkrypt operations](enkrypt-sync-operations.md)).

## Relevant Enkrypt capabilities

| Capability | Notes |
|---|---|
| Saved guardrails (`POST /guardrails/guardrail/detect`) | Separate input and output detector sets, selected with `X-Enkrypt-Mode: prompt\|response`. Per-detector `block_message`; the response carries a displayable `result_message`. `user_metadata` (up to 4 KB) is echoed back for correlation. |
| Detectors | Injection/jailbreak, PII and secrets, toxicity/NSFW, keyword, topic, policy violation (LLM judge with structured rules mapped to frameworks such as HIPAA and GDPR), bias, sponge attack. |
| PII anonymization (`POST /guardrails/pii`) | Replaces values with placeholders like `<PERSON_0>` and returns a key; a response-mode call restores them. The mapping expires after 1 hour. |
| AI Proxy | OpenAI-compatible proxy bound to one saved deployment and one model. |
| [Credits](https://docs.enkryptai.com/resources/credits) | Cheap detectors cost 1 credit. `injection_attack` costs 2 per 1,024 characters and `policy_violation` 5 per 5,000, both capped at 25 units. `policy_violation` explanations are on by default and double its cost. `shadow` mode reports cost without charging or blocking. |

## Ideas

Ordered from lowest to highest effort.

### 1. Model access policy from Enkrypt risk scores

Let enterprise admins add a group-policy rule such as "deny models whose Enkrypt risk score is above
X", evaluated in `evaluateEffectiveModelAccessPolicy`
(`packages/web-shared/src/lib/organizations/group-policies/model-access/model-access.server.ts`).

- No request latency and no prompt data sent to a third party.
- Reuses the scores we already ingest.
- Gated on the same redistribution approval as `ENKRYPT_PUBLICATION_ENABLED`.

### 2. Shadow-mode audit scanning

Scan each turn asynchronously after the response is sent, using the existing `after()` hook in
`packages/web-shared/src/lib/ai-gateway/handlers/llm-proxy.ts`, and store the detections.

- Never blocks and adds no latency to the response path.
- Enabled per organization for internal and design-partner organizations only.
- Measures what the docs cannot tell us: false-positive rates on coding-agent traffic, credit cost
  per request (`X-Enkrypt-Credits-Cost`), and Enkrypt latency from our Vercel regions.

This data decides whether ideas 3 to 6 are viable.

### 3. Opt-in blocking input guardrail for enterprise organizations

- Organization setting: enabled flag, guardrail, and fail-open or fail-closed behavior.
- Start the detect call early, like the Bouncer check, and await it just before the upstream request
  so detection overlaps authentication, balance checks, and routing.
- On a block, return a 4xx with Enkrypt's `result_message` so clients show a specific reason.
- Scan only the new part of the conversation (the latest user message and tool results since the
  last assistant turn), never the full history. Coding requests often carry more than 100k
  characters, and rescanning them every turn wastes credits and latency.

### 4. Indirect prompt-injection scanning of tool results

The threat most specific to coding agents is injected instructions in file contents, web fetches, and
MCP output, not in the user's own message. Run `injection_attack` and `pii` (secrets only) on
`tool` and `tool_result` content. This keeps the detector set small, cheap, and relevant, and could
be idea 3's default guardrail.

### 5. Secret and PII redaction before the upstream provider

- One-way secret masking before the provider sees the request. Simple, and covers the most common
  data-leak concern.
- Two-way PII anonymization is more expensive: streamed responses need a buffering transformer
  because a placeholder can be split across SSE chunks (`rewriteSseStream` in
  `packages/web-shared/src/lib/ai-gateway/rewriteModelResponse.shared.ts`), and the 1-hour mapping
  expiry is too short for long agent sessions.

Start with one-way masking.

### 6. Output scanning of streamed responses

Accumulate assistant text and scan every N characters and at the end of the stream. On a block, emit
an SSE error event and cancel the upstream request, using `rewriteSseStream` and the per-format
`onEvent` handlers. The client has already displayed part of the response when a block arrives, so
this suits audit and compliance use, not hard safety guarantees. Non-streaming responses can be
scanned before the JSON is returned.

### 7. Offline red-teaming through the gateway

Point Enkrypt red-team runs at the gateway's OpenAI-compatible endpoint, for example to evaluate
auto-routing or organization default models. Requires no gateway changes.

### Not recommended: the AI Proxy as an upstream provider

Each Enkrypt deployment is pinned to one saved model, which conflicts with gateway routing, BYOK, and
provider selection, and it adds a network hop.

## Suggested first step

Ship idea 2 with idea 4's detector set for a small set of internal organizations. Idea 1 can proceed
in parallel because it has no runtime risk. Enable blocking (idea 3) only once false-positive rate,
cost, and latency data support it.

## Open questions

- **Latency and regions.** The docs do not state response times or hosting regions.
- **Input size.** The docs do not say whether detectors truncate long inputs; the 25-unit cap is a
  billing cap.
- **Data handling.** Sending prompts to Enkrypt adds a data processor. It must be an organization
  opt-in, and its interaction with the `data_collection` and ZDR settings must be defined.
- **Billing.** Kilo credits passed through to the customer, or a customer-supplied Enkrypt key.
