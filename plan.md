# Plan: Bot Identity Onboarding Step

## Goal

Add a new step to the KiloClaw onboarding flow that asks users about their bot's identity (name, nature, vibe, emoji). The identity data must be persisted in durable storage and written to `workspace/IDENTITY.md` on the instance filesystem so the bot is ready to go when the instance starts.

## Data Model

```ts
type BotIdentity = {
  botName: string | null;     // "What should they call you?"
  botNature: string | null;   // "What kind of creature are you?"
  botVibe: string | null;     // "Formal? Casual? Snarky? Warm?"
  botEmoji: string | null;    // "Everyone needs a signature."
};
```

## Architecture

Follows the same pattern as the exec permissions preset (`execSecurity`/`execAsk`):

1. **Persist in DO state** — fields survive restarts
2. **Transport via env vars** — `KILOCLAW_BOT_NAME`, `KILOCLAW_BOT_NATURE`, `KILOCLAW_BOT_VIBE`, `KILOCLAW_BOT_EMOJI`
3. **Controller bootstrap writes `workspace/IDENTITY.md`** from env vars on every boot
4. **During onboarding**, the ProvisioningStep also writes the file to the running instance via a new controller endpoint (since the machine is already booted before the user fills the form)

## Onboarding Flow (Updated)

```
CreateInstanceCard → BotIdentityStep (NEW) → PermissionStep → ChannelSelectionStep → ProvisioningStep → [ChannelPairingStep] → Done
```

Step indicator numbering: 2, 3, 4, 5, [6]. Total steps: `hasPairingStep ? 6 : 5` (was `hasPairingStep ? 5 : 4`).

## Changes by Layer

### 1. Frontend — New `BotIdentityStep` Component

**New file:** `src/app/(app)/claw/components/BotIdentityStep.tsx`

Form with four fields:
- **Name** — text input, placeholder "e.g. Clawdia, Byte, Archie"
- **Nature** — text input, placeholder "e.g. AI assistant, digital familiar, code gremlin"
- **Vibe** — text input or select with options like Casual, Formal, Snarky, Warm, Playful
- **Emoji** — text input (single emoji), placeholder "e.g. 🦀, 🤖, ⚡"

"Continue" button advances to PermissionStep. All fields optional (user can skip/leave blank).

Uses `OnboardingStepView` wrapper with `currentStep={2}`, `showProvisioningBanner={!instanceRunning}`.

### 2. Frontend — Update `ClawDashboard.tsx`

- Add `'identity'` to the onboarding step union type: `'identity' | 'permissions' | 'channels' | 'provisioning' | 'pairing' | 'done'`
- Set initial step to `'identity'` instead of `'permissions'`
- Add state: `botIdentity` (holds `{ botName, botNature, botVibe, botEmoji }`)
- Wire up the new step in the render chain:
  ```
  isNewSetup && onboardingStep === 'identity' → <BotIdentityStep onComplete={...} />
  ```
- On identity step completion: store identity state, advance to `'permissions'`
- Pass `botIdentity` to `ProvisioningStep`
- Bump `totalSteps` from 4/5 to 5/6

### 3. Frontend — Update `ProvisioningStep.tsx`

- Accept new `botIdentity` prop
- When `instanceRunning` becomes true, alongside existing config patching:
  - Call `mutations.patchBotIdentity(identity)` to persist to DO **and** write IDENTITY.md to the running instance

### 4. Frontend — Update `claw.types.ts`

- Add `BotIdentity` type export
- Export it from claw.types so it's available to components

### 5. Frontend — Update Step Numbering

- `PermissionStep`: `currentStep` 2 → 3
- `ChannelSelectionStep`: `currentStep` 3 → 4
- `ProvisioningStep`: `currentStep` 4 → 5
- `ChannelPairingStep`: `currentStep` 5 → 6

### 6. Hooks — `useKiloClaw.ts`

Add mutation:
```ts
patchBotIdentity: useMutation(
  trpc.kiloclaw.patchBotIdentity.mutationOptions({ onSuccess: invalidateStatus })
),
```

### 7. Hooks — `useOrgKiloClaw.ts`

Add equivalent org mutation for org-scoped instances.

### 8. tRPC Router — `kiloclaw-router.ts`

New mutation:
```ts
patchBotIdentity: clawAccessProcedure
  .input(z.object({
    botName: z.string().max(100).nullable().optional(),
    botNature: z.string().max(200).nullable().optional(),
    botVibe: z.string().max(200).nullable().optional(),
    botEmoji: z.string().max(10).nullable().optional(),
  }))
  .mutation(async ({ ctx, input }) => {
    const instance = await getActiveInstance(ctx.user.id);
    const client = new KiloClawInternalClient();
    return client.patchBotIdentity(ctx.user.id, input, workerInstanceId(instance));
  }),
```

### 9. tRPC Router — `organization-kiloclaw-router.ts`

Mirror the `patchBotIdentity` mutation for org-scoped access.

### 10. Internal Client — `kiloclaw-internal-client.ts`

New method:
```ts
async patchBotIdentity(
  userId: string,
  patch: { botName?: string | null; botNature?: string | null; botVibe?: string | null; botEmoji?: string | null },
  instanceId?: string,
): Promise<{ ok: boolean }> {
  // PATCH /api/platform/bot-identity
}
```

### 11. CF Worker Platform Route — `platform.ts`

New route:
```
PATCH /api/platform/bot-identity
```
Schema: `{ userId, botName?, botNature?, botVibe?, botEmoji? }`

Calls `stub.updateBotIdentity(patch)` on the Instance DO.

### 12. DO Method — `kiloclaw-instance/index.ts`

New method `updateBotIdentity()`:
1. Persist fields to DO state (`ctx.storage.put(...)`)
2. If machine is running, call `gateway.writeBotIdentity(this.s, this.env, identity)` to write IDENTITY.md to the running instance (fire-and-forget, non-fatal)
3. Return `{ ok: true }`

### 13. DO State — Schema & Types

**`instance-config.ts` (PersistedStateSchema):**
```ts
botName: z.string().nullable().default(null),
botNature: z.string().nullable().default(null),
botVibe: z.string().nullable().default(null),
botEmoji: z.string().nullable().default(null),
```

**`types.ts` (InstanceMutableState):**
Add four nullable string fields.

**`state.ts` (loadState/clearState):**
Add fields to state loading from persisted data and clearing on destroy.

### 14. Gateway Module — `gateway.ts`

New function:
```ts
export async function writeBotIdentity(
  state: InstanceMutableState,
  env: KiloClawEnv,
  identity: { botName?: string | null; botNature?: string | null; botVibe?: string | null; botEmoji?: string | null },
): Promise<{ ok: boolean }> {
  return callGatewayController(state, env, '/_kilo/bot-identity', 'POST', GatewayCommandResponseSchema, identity);
}
```

### 15. Env Vars — `env.ts`

In `buildEnvVars()`, add after the exec preset block:
```ts
if (userConfig?.botName) plainEnv.KILOCLAW_BOT_NAME = userConfig.botName;
if (userConfig?.botNature) plainEnv.KILOCLAW_BOT_NATURE = userConfig.botNature;
if (userConfig?.botVibe) plainEnv.KILOCLAW_BOT_VIBE = userConfig.botVibe;
if (userConfig?.botEmoji) plainEnv.KILOCLAW_BOT_EMOJI = userConfig.botEmoji;
```

Also add to `UserConfig` type.

### 16. Controller — New Endpoint `POST /_kilo/bot-identity`

**File:** `kiloclaw/controller/src/routes/` (new route registration, or in an existing routes file)

Accepts: `{ botName?, botNature?, botVibe?, botEmoji? }`

Generates markdown:
```markdown
# Identity

- **Name:** Clawdia
- **Nature:** AI assistant with a taste for automation
- **Vibe:** Casual and a little snarky
- **Emoji:** 🦀
```

Writes to `workspace/IDENTITY.md` (creates file + parent dirs if needed). Uses `resolveSafePath` for security, `atomicWrite` for reliability.

Returns `{ ok: true }`.

### 17. Controller Bootstrap — `bootstrap.ts`

In `runOnboardOrDoctor()`, after seeding TOOLS.md on first provision, also write IDENTITY.md from env vars:

```ts
const identityEnv = {
  name: env.KILOCLAW_BOT_NAME,
  nature: env.KILOCLAW_BOT_NATURE,
  vibe: env.KILOCLAW_BOT_VIBE,
  emoji: env.KILOCLAW_BOT_EMOJI,
};
if (Object.values(identityEnv).some(Boolean)) {
  writeIdentityMd(identityEnv, deps);
}
```

This runs on EVERY boot (not just first provision), ensuring identity changes from the DO state are picked up on restart. Extract the markdown generation into a shared helper used by both the `/_kilo/bot-identity` endpoint and bootstrap.

### 18. DO Config Module — `config.ts`

In the `buildUserConfig()` function that assembles the UserConfig passed to `buildEnvVars`, add identity fields:
```ts
botName: state.botName ?? undefined,
botNature: state.botNature ?? undefined,
botVibe: state.botVibe ?? undefined,
botEmoji: state.botEmoji ?? undefined,
```

## Tests

| Layer | Test file | What to test |
|-------|-----------|-------------|
| DO method | `kiloclaw-instance.test.ts` | `updateBotIdentity` persists state, returns values |
| Env vars | `env.test.ts` | Identity env vars appear when set, absent when null |
| Controller endpoint | New test file or `files.test.ts` | `/_kilo/bot-identity` writes IDENTITY.md correctly |
| Bootstrap | `bootstrap.test.ts` / `config-writer.test.ts` | Identity env vars produce IDENTITY.md on boot |
| tRPC | Existing router test patterns | Mutation calls through to internal client |

## File Summary

| File | Action |
|------|--------|
| `src/app/(app)/claw/components/BotIdentityStep.tsx` | **Create** |
| `src/app/(app)/claw/components/ClawDashboard.tsx` | Modify |
| `src/app/(app)/claw/components/ProvisioningStep.tsx` | Modify |
| `src/app/(app)/claw/components/PermissionStep.tsx` | Modify (step number) |
| `src/app/(app)/claw/components/ChannelSelectionStep.tsx` | Modify (step number) |
| `src/app/(app)/claw/components/ChannelPairingStep.tsx` | Modify (step number) |
| `src/app/(app)/claw/components/claw.types.ts` | Modify |
| `src/hooks/useKiloClaw.ts` | Modify |
| `src/hooks/useOrgKiloClaw.ts` | Modify |
| `src/routers/kiloclaw-router.ts` | Modify |
| `src/routers/organizations/organization-kiloclaw-router.ts` | Modify |
| `src/lib/kiloclaw/kiloclaw-internal-client.ts` | Modify |
| `kiloclaw/src/schemas/instance-config.ts` | Modify |
| `kiloclaw/src/durable-objects/kiloclaw-instance/types.ts` | Modify |
| `kiloclaw/src/durable-objects/kiloclaw-instance/state.ts` | Modify |
| `kiloclaw/src/durable-objects/kiloclaw-instance/index.ts` | Modify |
| `kiloclaw/src/durable-objects/kiloclaw-instance/gateway.ts` | Modify |
| `kiloclaw/src/durable-objects/kiloclaw-instance/config.ts` | Modify |
| `kiloclaw/src/routes/platform.ts` | Modify |
| `kiloclaw/src/gateway/env.ts` | Modify |
| `kiloclaw/controller/src/bootstrap.ts` | Modify |
| `kiloclaw/controller/src/routes/` | Modify (add identity endpoint) |
| Test files | Modify/create as needed |
