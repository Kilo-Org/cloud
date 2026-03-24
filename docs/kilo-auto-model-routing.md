# Kilo Auto Model Routing

Kilo Auto models are virtual model IDs that route requests to different underlying provider models based on the requested tier and the client's current mode (e.g. `code`, `architect`, `plan`).

**Source of truth:** `src/lib/kilo-auto-model.ts`

## Model Tiers

| Kilo Auto Model ID    | Name                | Description                                         |
| --------------------- | ------------------- | --------------------------------------------------- |
| `kilo-auto/frontier`  | Kilo Auto Frontier  | Highest performance. Uses Claude Opus / Sonnet.     |
| `kilo-auto/balanced`  | Kilo Auto Balanced  | Price/capability balance. Uses Kimi K2.5 / MiniMax. |
| `kilo-auto/free`      | Kilo Auto Free      | Free, limited capability. Uses MiniMax M2.5 free.   |
| `kilo-auto/small`     | Kilo Auto Small     | Cheap small model. Uses GPT-5 Nano.                 |

## Routing Tables

### Frontier (`kilo-auto/frontier`)

| Client Mode                                      | Underlying Model               | Reasoning | Verbosity |
| ------------------------------------------------ | ------------------------------ | --------- | --------- |
| plan, architect, orchestrator, ask, debug         | `anthropic/claude-opus-4.6`    | enabled   | high      |
| general                                          | `anthropic/claude-opus-4.6`    | enabled   | medium    |
| build, explore                                   | `anthropic/claude-sonnet-4.6`  | enabled   | medium    |
| code *(default fallback)*                        | `anthropic/claude-sonnet-4.6`  | enabled   | low       |

When the feature header is `kiloclaw`, the mode is forced to `plan` (resolving to Opus).

### Balanced (`kilo-auto/balanced`)

| Client Mode                                      | Underlying Model               | Reasoning |
| ------------------------------------------------ | ------------------------------ | --------- |
| plan, general, architect, orchestrator, ask, debug | `moonshotai/kimi-k2.5`        | enabled   |
| build, explore, code *(default fallback)*        | `minimax/minimax-m2.7`         | --        |

### Free (`kilo-auto/free`)

All modes resolve to `minimax/minimax-m2.5:free`. No reasoning or verbosity config is applied.

### Small (`kilo-auto/small`)

All modes resolve to `openai/gpt-5-nano`. No reasoning or verbosity config is applied.

## How Routing Works

1. The client sends a request with a `kilo-auto/*` model ID and an `x-kilocode-mode` header (e.g. `code`, `architect`).
2. The API route at `src/app/api/openrouter/[...path]/route.ts` checks `isKiloAutoModel()` and calls `applyResolvedAutoModel()`.
3. `resolveAutoModel()` in `src/lib/kilo-auto-model.ts` maps the tier + mode to an underlying provider model, and optionally sets reasoning and verbosity config on the request body.

## Legacy Aliases

Old model IDs are mapped to current tiers via `legacyMapping`:

| Legacy ID         | Maps To               |
| ----------------- | ---------------------- |
| `kilo/auto`       | `kilo-auto/frontier`   |
| `kilo/auto-free`  | `kilo-auto/free`       |
| `kilo/auto-small` | `kilo-auto/small`      |

## Platform Defaults

- **Default model** (for new users with credits): `kilo-auto/balanced` (see `src/app/api/defaults/route.ts`)
- **Default free model**: `kilo-auto/free`
- **Bot / integration default**: `kilo-auto/free` (Slack, Discord)
- **Summary model**: `kilo-auto/small`
- **KiloClaw instances**: `kilo-auto/frontier` when user has credits, `kilo-auto/free` otherwise

## Changing the Routing

To update which underlying model a tier routes to, edit the corresponding `Map` or constant in `src/lib/kilo-auto-model.ts`:

- `FRONTIER_MODE_TO_MODEL` / `FRONTIER_CODE_MODEL` for frontier
- `BALANCED_MODE_TO_MODEL` / `BALANCED_CODE_MODEL` for balanced
- The `resolveAutoModel` function body for free and small (direct returns)
