# Reproduce thinking-block prefix mismatches

This opt-in diagnostic makes billed requests to Anthropic and Vercel AI Gateway.
It uses synthetic prompts and imports the production
`dropThinkingBlocksOnPrefixMismatch` helper rather than copying its behavior.
It does not call Kilo's hosted gateway or exercise its authentication and routing.

## Run

Use Node 24 and install the workspace dependencies. Export `ANTHROPIC_API_KEY`
and `VERCEL_AI_GATEWAY_API_KEY` in your shell, then run from the repository root:

```sh
pnpm exec tsx --tsconfig packages/web-shared/tsconfig.json packages/web-shared/scripts/reproduce-thinking-prefix-mismatch.ts --model sonnet --vercel-byok
```

This selects Claude Sonnet 5.5 for both endpoints. The explicit `"error"` control
tests rejection independently of the account's default policy. To reproduce
default rejection on the direct API with Claude Fable 5.2:

```sh
pnpm exec tsx --tsconfig packages/web-shared/tsconfig.json packages/web-shared/scripts/reproduce-thinking-prefix-mismatch.ts --target anthropic --model fable
```

`--target anthropic` or `--target vercel` limits the endpoints. Use
`--model haiku` to select Claude Haiku 5.5, including for a direct API probe of
the explicitly disabled-thinking mode. Sonnet 5.5 and Fable 5.2 reject that
disabled mode on the direct Messages API. `--seed-thinking adaptive` is the
default; `--seed-thinking absent` omits the `thinking` field from the signed
history seed request. For example, the direct zero-config seed is:

```sh
pnpm exec tsx --tsconfig packages/web-shared/tsconfig.json packages/web-shared/scripts/reproduce-thinking-prefix-mismatch.ts --target anthropic --model haiku --seed-thinking absent
```

Without `--vercel-byok`, Vercel uses its configured credentials. With that flag, the
script sends the Anthropic key as request-scoped BYOK to Vercel as well as using
it directly. Vercel can still fall back to system credentials.

For Vercel-managed Bedrock or Vertex, omit `--vercel-byok` and select
`--target vercel --vercel-provider bedrock` or
`--target vercel --vercel-provider vertex`. Model availability depends on the
provider and account.

## What it tests

1. Obtain a completed answer containing genuinely signed thinking blocks.
2. Replay the full assistant response with an unchanged system prompt as a control.
3. Change only a synthetic marker in the system prompt and replay the same history.
4. Compare the unmodified request, the production helper, and an explicit
   `prefix_mismatch_behavior: "error"` control.
5. Probe helper and bypass controls for nonadaptive configurations. The helper
   preserves the explicit mode and strips top-level historical thinking blocks.

The diagnostic keeps signed content in memory and prints only bounded diagnostic
metadata. It does not print credentials, request headers, thinking text, or
signatures. A seed without signed thinking is inconclusive, not a successful
reproduction; adaptive thinking does not guarantee a block on every request.

## Interpret the results

- HTTP 400 with ``Invalid `signature` in `thinking` block`` and the conversation
  mismatch explanation reproduces the target error. Unsupported-thinking-mode
  errors are different failures.
- HTTP 200 with `thinking_dropped` / `prefix_binding_mismatch` demonstrates that
  mismatched thinking was dropped. HTTP 200 alone does not establish this.
- `organization_binding_mismatch` means the account changed; that is not evidence
  that the prefix-mismatch workaround was exercised.
- Default mismatch enforcement varies by model and account. Fable 5.2 enforces it
  on the direct API; Sonnet 5.5 can accept an unmodified mismatched request.
  Vercel may also drop blocks itself. The explicit `"error"` control makes the
  rejection test independent of an account's default policy, unless a block is
  dropped for another reason first.
- The helper deliberately preserves an explicit caller policy of `"error"`.
  A failing explicit-error control therefore does not show a missing provider hook.
- An omitted `thinking` field on an eligible Claude Messages request is treated as
  adaptive by the helper: it adds `block_binding: { prefix_mismatch_behavior:
  "drop_block" }` and both beta headers without changing history. The
  `changed-absent` case exercises this behavior; the optional absent seed mode is
  separate and deliberately runs without the helper.
- With explicit `enabled` or `disabled` thinking, the helper preserves the mode
  and other request content, adds both beta headers, and strips historical
  assistant `thinking` and `redacted_thinking` blocks. Empty assistant messages
  left by that removal are omitted. The `changed-disabled-without-helper` case
  is a negative control that leaves history unchanged; inspect
  `historicalThinkingBlocksBefore` and `historicalThinkingBlocksAfter` to see the
  strip without exposing block content. `thinkingMode` reports the outgoing
  request mode, while `inputThinkingMode` reports the initial setting.

See Anthropic's [preserved-thinking documentation](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
and Vercel's [request-scoped BYOK documentation](https://vercel.com/docs/ai-gateway/authentication-and-byok/byok#request-scoped-byok).

## Offline checks

These tests use the real helper but do not require credentials or make requests:

```sh
pnpm exec tsx --tsconfig packages/web-shared/tsconfig.json --test packages/web-shared/scripts/reproduce-thinking-prefix-mismatch.test.ts
```
