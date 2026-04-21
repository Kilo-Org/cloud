# Kilo Chat Plugin Issues Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four identified issues in the kilo-chat OpenClaw channel plugin: config schema mismatch, fake reactionLevel field, session isolation for conversations, and blank message bodies in the read action.

**Architecture:** Four independent fixes across the plugin manifest, config-writer, and read-action. Each fix is self-contained with its own tests. The session fix adds a defensive default in config-writer; the read-action fix changes message text extraction from `msg.text` to `msg.content` blocks.

**Tech Stack:** TypeScript, Vitest, OpenClaw plugin SDK, `@kilocode/kilo-chat` types

---

## File Map

| File                                                          | Change                                                                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `services/kiloclaw/plugins/kilo-chat/openclaw.plugin.json`    | Remove `configSchema`                                                     |
| `services/kiloclaw/controller/src/config-writer.ts`           | Replace `reactionLevel` with `_configured`, add `session.dmScope` default |
| `services/kiloclaw/controller/src/config-writer.test.ts`      | Update kilo-chat test assertions, add session.dmScope test                |
| `services/kiloclaw/plugins/kilo-chat/src/read-action.ts`      | Extract text from `msg.content` blocks instead of `msg.text`              |
| `services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts` | Update mock data to use real API shape (`content` blocks)                 |

---

### Task 1: Remove misleading configSchema from manifest

The manifest's `configSchema` describes a schema path that doesn't match where config is actually written at runtime. Since OpenClaw doesn't validate this schema at runtime for native channel plugins, removing it eliminates confusion without any behavioral change.

**Files:**

- Modify: `services/kiloclaw/plugins/kilo-chat/openclaw.plugin.json`

- [ ] **Step 1: Remove the configSchema field**

Replace the full manifest content with:

```json
{
  "id": "kilo-chat",
  "kind": "channel",
  "name": "Kilo Chat",
  "description": "Kilo Chat channel plugin",
  "channels": ["kilo-chat"],
  "channelEnvVars": {
    "kilo-chat": []
  }
}
```

- [ ] **Step 2: Run plugin tests to verify no breakage**

Run: `pnpm --filter @kiloclaw/kilo-chat test`
Expected: All tests pass (the manifest is not imported by any test).

- [ ] **Step 3: Commit**

```bash
git add services/kiloclaw/plugins/kilo-chat/openclaw.plugin.json
git commit -m "fix(kilo-chat): remove misleading configSchema from manifest"
```

---

### Task 2: Replace reactionLevel with \_configured marker

The `reactionLevel: 'minimal'` field on `config.channels['kilo-chat']` exists solely to satisfy OpenClaw's `hasMeaningfulChannelConfig` gate (which requires at least one non-`enabled` key). It misleadingly implies reaction behavior. Replace it with `_configured: true` — an honest internal marker.

**Files:**

- Modify: `services/kiloclaw/controller/src/config-writer.ts:465-472`
- Modify: `services/kiloclaw/controller/src/config-writer.test.ts:800-812`

- [ ] **Step 1: Update the test to expect `_configured` instead of `reactionLevel`**

In `config-writer.test.ts`, find the kilo-chat test (around line 800) and change the assertion:

```typescript
// ─── Kilo Chat ───────────────────────────────────────────────────────────

it('always configures kilo-chat channel and plugin', () => {
  const { deps } = fakeDeps();
  const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

  expect(config.channels['kilo-chat'].enabled).toBe(true);
  // _configured provides the non-`enabled` key required by OpenClaw's
  // hasMeaningfulChannelConfig gate (see comment in config-writer.ts).
  expect(config.channels['kilo-chat']._configured).toBe(true);
  expect(config.channels['kilo-chat']).not.toHaveProperty('reactionLevel');
  expect(config.plugins.load.paths).toContain('/usr/local/lib/node_modules/@kiloclaw/kilo-chat');
  expect(config.plugins.entries['kilo-chat'].enabled).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter kiloclaw test controller/src/config-writer.test.ts`
Expected: FAIL — `_configured` is undefined, `reactionLevel` still present.

- [ ] **Step 3: Update config-writer to use `_configured`**

In `config-writer.ts`, replace lines 465-472:

```typescript
// Kilo Chat — always enabled. The plugin's outbound path reaches
// kilo-chat via controller proxy → kilo-chat Worker directly.
config.channels['kilo-chat'] = config.channels['kilo-chat'] ?? {};
config.channels['kilo-chat'].enabled = true;
// Load-bearing: _configured is the marker key for OpenClaw's
// hasMeaningfulChannelConfig gate — without a non-`enabled` key the
// plugin loads in setup-runtime mode instead of full.
config.channels['kilo-chat']._configured = true;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter kiloclaw test controller/src/config-writer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/kiloclaw/controller/src/config-writer.ts services/kiloclaw/controller/src/config-writer.test.ts
git commit -m "fix(kilo-chat): replace fake reactionLevel with _configured marker"
```

---

### Task 3: Add defensive session.dmScope default

OpenClaw's `openclaw onboard` sets `session.dmScope: "per-channel-peer"` by default for fresh instances. However, legacy instances onboarded before this default was added may have no `session.dmScope`, causing all DM conversations across all channels to share one session (key: `agent:{id}:main`). Add a defensive default in config-writer to ensure `per-channel-peer` is always set.

**Files:**

- Modify: `services/kiloclaw/controller/src/config-writer.ts` (near line 465, before the kilo-chat section)
- Modify: `services/kiloclaw/controller/src/config-writer.test.ts`

- [ ] **Step 1: Add test for session.dmScope default**

Add a new test in `config-writer.test.ts` in the `generateBaseConfig` describe block, after the kilo-chat test:

```typescript
// ─── Session ─────────────────────────────────────────────────────────────

it('defaults session.dmScope to per-channel-peer', () => {
  const { deps } = fakeDeps();
  const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

  expect(config.session.dmScope).toBe('per-channel-peer');
});

it('preserves existing session.dmScope', () => {
  const existing = JSON.stringify({
    gateway: { port: 3001, mode: 'local' },
    agents: { defaults: { model: { primary: 'kilocode/anthropic/claude-opus-4.6' } } },
    session: { dmScope: 'per-peer' },
    plugins: { entries: { telegram: { enabled: false }, discord: { enabled: false } } },
  });
  const { deps } = fakeDeps(existing);
  const config = generateBaseConfig(minimalEnv(), '/tmp/openclaw.json', deps);

  expect(config.session.dmScope).toBe('per-peer');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter kiloclaw test controller/src/config-writer.test.ts`
Expected: FAIL — `config.session` is undefined (for the default test).

- [ ] **Step 3: Add session.dmScope default to config-writer**

In `config-writer.ts`, add the following before the kilo-chat channel section (before the comment `// Kilo Chat — always enabled`):

```typescript
// Session — default DM scope to per-channel-peer so each channel+peer
// combination gets its own session. OpenClaw's onboard sets this for new
// instances, but legacy instances may not have it.
config.session = config.session ?? {};
config.session.dmScope = config.session.dmScope ?? 'per-channel-peer';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter kiloclaw test controller/src/config-writer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/kiloclaw/controller/src/config-writer.ts services/kiloclaw/controller/src/config-writer.test.ts
git commit -m "fix(kilo-chat): default session.dmScope to per-channel-peer for session isolation"
```

---

### Task 4: Fix read action to extract text from content blocks

The read action extracts `msg.text` but the kilo-chat API returns messages with `msg.content: ContentBlock[]` where each block is `{ type: 'text', text: '...' }`. The current code always renders empty message bodies. Fix extraction to join text from content blocks.

**Files:**

- Modify: `services/kiloclaw/plugins/kilo-chat/src/read-action.ts:40-44`
- Modify: `services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts`

- [ ] **Step 1: Update test mock data to use real API shape**

In `read-action.test.ts`, update the happy path test (first test) to use `content` blocks instead of `text`:

```typescript
it('returns formatted messages on happy path', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [
        { id: 'MSG1', senderId: 'alice', content: [{ type: 'text', text: 'Hello' }] },
        { id: 'MSG2', senderId: 'bob', content: [{ type: 'text', text: 'World' }] },
      ],
    }),
  });

  const result = await handleKiloChatReadAction({
    params: { to: 'CONV' },
    client,
  });

  expect(client.listMessages).toHaveBeenCalledWith({ conversationId: 'CONV', limit: undefined });
  expect(result.content).toHaveLength(1);
  expect(result.content[0].text).toBe('[MSG1] alice: Hello\n[MSG2] bob: World');
});
```

Also update the limit test (third test) to use the real shape:

```typescript
it('passes limit param to listMessages', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [{ id: 'M1', senderId: 'alice', content: [{ type: 'text', text: 'Hi' }] }],
    }),
  });

  await handleKiloChatReadAction({
    params: { to: 'CONV', limit: 5 },
    client,
  });

  expect(client.listMessages).toHaveBeenCalledWith({ conversationId: 'CONV', limit: 5 });
});
```

Add a test for multi-block messages:

```typescript
it('joins multiple content blocks', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [
        {
          id: 'MSG1',
          senderId: 'alice',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'World' },
          ],
        },
      ],
    }),
  });

  const result = await handleKiloChatReadAction({
    params: { to: 'CONV' },
    client,
  });

  expect(result.content[0].text).toBe('[MSG1] alice: Hello World');
});
```

Add a test for deleted messages (empty content):

```typescript
it('renders deleted messages with empty body', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [{ id: 'MSG1', senderId: 'alice', content: [], deleted: true }],
    }),
  });

  const result = await handleKiloChatReadAction({
    params: { to: 'CONV' },
    client,
  });

  expect(result.content[0].text).toBe('[MSG1] alice: ');
});
```

Add a test for missing content field (graceful fallback):

```typescript
it('handles messages with no content field gracefully', async () => {
  const client = mockClient({
    listMessages: vi.fn().mockResolvedValue({
      messages: [{ id: 'MSG1', senderId: 'alice' }],
    }),
  });

  const result = await handleKiloChatReadAction({
    params: { to: 'CONV' },
    client,
  });

  expect(result.content[0].text).toBe('[MSG1] alice: ');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @kiloclaw/kilo-chat test src/read-action.test.ts`
Expected: FAIL — current code reads `msg.text` which doesn't exist on the new mock shape.

- [ ] **Step 3: Update read-action.ts to extract text from content blocks**

Replace the message formatting logic (lines 40-44) in `read-action.ts`:

```typescript
const lines = messages.map(msg => {
  const id = typeof msg.id === 'string' ? msg.id : String(msg.id ?? '');
  const sender = typeof msg.senderId === 'string' ? msg.senderId : String(msg.senderId ?? '');
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const text = blocks
    .filter(
      (b: unknown): b is { type: string; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        'text' in b &&
        typeof (b as Record<string, unknown>).text === 'string'
    )
    .map(b => b.text)
    .join('');
  return `[${id}] ${sender}: ${text}`;
});
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @kiloclaw/kilo-chat test src/read-action.test.ts`
Expected: PASS — all tests including the new multi-block, deleted, and graceful fallback tests.

- [ ] **Step 5: Commit**

```bash
git add services/kiloclaw/plugins/kilo-chat/src/read-action.ts services/kiloclaw/plugins/kilo-chat/src/read-action.test.ts
git commit -m "fix(kilo-chat): extract message text from content blocks in read action"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run format**

Run: `pnpm format`

- [ ] **Step 2: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Run affected tests**

Run: `pnpm --filter kiloclaw test && pnpm --filter @kiloclaw/kilo-chat test`
Expected: All pass.

- [ ] **Step 4: Commit if format changed anything**

```bash
git add -A && git diff --cached --quiet || git commit -m "style: format"
```
