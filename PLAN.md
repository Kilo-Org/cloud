# App Builder Send Feedback — Implementation Plan

## Overview

Add a "Send Feedback" button in the App Builder chat header bar that opens a simple dialog where users can type feedback. On submission, feedback is stored in a new dedicated `app_builder_feedback` table along with automatically collected meta information about the current session state. A Slack notification is sent best-effort.

## Database table: `app_builder_feedback`

| Column            | Type                                                   | Description                                              |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------- |
| `id`              | uuid PK                                                | Auto-generated                                           |
| `kilo_user_id`    | text (FK → kilocode_users.id, on delete set null)      | The authenticated user                                   |
| `project_id`      | uuid (FK → app_builder_projects.id, on delete cascade) | The app builder project                                  |
| `session_id`      | text                                                   | Cloud Agent session ID (nullable, copied at submit time) |
| `model`           | text                                                   | Model in use at submit time                              |
| `preview_status`  | text                                                   | idle / building / running / error                        |
| `is_streaming`    | boolean                                                | Whether AI was actively streaming                        |
| `message_count`   | integer                                                | Number of messages in the session                        |
| `feedback_text`   | text, NOT NULL                                         | The user's typed feedback                                |
| `recent_messages` | jsonb                                                  | Last 5 messages (lightweight: role, text, ts)            |
| `created_at`      | timestamptz, NOT NULL, default now()                   | Timestamp                                                |

Indexes: `created_at`, `kilo_user_id`, `project_id`.

## Files to change

### 1. `src/db/schema.ts` — Add table definition

Add the `app_builder_feedback` table following existing conventions:

- Use `uuid().default(sql\`pg_catalog.gen_random_uuid()\`).primaryKey().notNull()`for`id`
- FK `kilo_user_id` → `kilocode_users.id` with `onDelete: 'set null'`
- FK `project_id` → `app_builder_projects.id` with `onDelete: 'cascade'`
- Export `AppBuilderFeedback` and `NewAppBuilderFeedback` inferred types

### 2. Generate migration

Run `pnpm drizzle generate` to produce `src/db/migrations/0005_*.sql`.

### 3. `src/routers/app-builder-feedback-router.ts` — New file

Single tRPC router with one `create` mutation:

```
Input (Zod):
  - project_id: z.string().uuid()
  - feedback_text: z.string().min(1)
  - session_id: z.string().optional()
  - model: z.string().optional()
  - preview_status: z.string().optional()
  - is_streaming: z.boolean().optional()
  - message_count: z.number().int().nonneg().optional()
  - recent_messages: z.array(...).optional()

Auth: baseProcedure (any authenticated user)

Logic:
  1. Insert into app_builder_feedback
  2. Best-effort Slack notification (same pattern as user-feedback-router.ts)
  3. Return { id } of inserted row
```

### 4. `src/routers/root-router.ts` — Mount new router

Add `appBuilderFeedback: appBuilderFeedbackRouter` to the root router.

### 5. `src/components/app-builder/FeedbackDialog.tsx` — New file

Dialog component following the `CloneDialog.tsx` pattern:

- Uses Radix `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`
- Contains a `<textarea>` for feedback text
- Submit button calls `trpc.appBuilderFeedback.create.mutate(...)` via `useMutation`
- Auto-collects context from `useProject()` hook at submit time:
  - `manager.projectId`
  - `state.model`
  - `state.previewStatus`
  - `state.isStreaming`
  - `state.messages.length`
  - Last 5 messages from `state.messages` (mapped to `{ role, text, ts }`)
- Session ID comes from the project data (available via ProjectLoader/ProjectSession)
- Shows loading spinner during submission, success message on completion, error on failure
- Closes automatically after successful submission (with brief success indication)

### 6. `src/components/app-builder/AppBuilderChat.tsx` — Add feedback button

In the chat header `<div>` (line ~399), add a feedback button next to "New Project":

- Use `MessageSquareWarning` (or similar) icon from lucide-react
- Renders `<FeedbackDialog>` which manages its own open/close state
- The button is always visible when a project is loaded (messages.length > 0 condition already exists for the input area)

## Architecture notes

- **Client-side context collection**: Meta information (model, preview status, message count, recent messages, streaming state) is collected on the client at the moment of submission. This captures the user's exact experience rather than server-side state which may differ.
- **Recent messages format**: Last 5 messages serialized as lightweight JSON array with only `{ role: string, text: string, ts: number }` per message. Heavy metadata, content blocks, and partial flags are stripped to keep the payload small.
- **No org-scoped router**: The feedback mutation uses `baseProcedure`. The `project_id` FK is sufficient to trace feedback back to an organization via the `app_builder_projects` table. This avoids duplicating the router.
- **Session ID**: The `session_id` on `app_builder_projects` is the Cloud Agent session ID. We copy it into the feedback row at submit time for easy correlation, even though it could be joined via `project_id`.

## Reference files

| File                                                | Why                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `src/components/app-builder/CloneDialog.tsx`        | Dialog UI pattern (Radix Dialog + tRPC mutation + loading states) |
| `src/routers/user-feedback-router.ts`               | Slack notification pattern, tRPC mutation structure               |
| `src/db/schema.ts:837`                              | `user_feedback` table for schema conventions                      |
| `src/db/schema.ts:2127`                             | `app_builder_projects` table (FK target)                          |
| `src/components/app-builder/AppBuilderChat.tsx:399` | Chat header where feedback button will be placed                  |
| `src/components/app-builder/ProjectSession.tsx`     | `useProject()` hook providing `manager` + `state`                 |
| `src/components/app-builder/ProjectManager.ts`      | `ProjectManager` class with `projectId` and state shape           |
