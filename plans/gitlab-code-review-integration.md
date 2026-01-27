# GitLab Code Review Integration Plan

## Overview

This plan outlines the implementation of GitLab code review support for Kilo Code, mirroring the existing GitHub functionality. The goal is to enable automated code reviews on GitLab Merge Requests (MRs) triggered by webhooks.

## Current Architecture (GitHub)

```mermaid
flowchart TD
    subgraph GitHub
        GH_PR[Pull Request Event]
        GH_WH[Webhook POST]
    end

    subgraph Kilo Backend
        WH_ROUTE[/api/webhooks/github/route.ts]
        PR_HANDLER[pull-request-handler.ts]
        CREATE_REVIEW[createCodeReview]
        DISPATCH[tryDispatchPendingReviews]
        PREPARE[prepareReviewPayload]
        PROMPT[generateReviewPrompt]
    end

    subgraph Cloudflare Worker
        CF_WORKER[Code Review Worker]
        ORCHESTRATOR[CodeReviewOrchestrator DO]
    end

    subgraph Cloud Agent
        AGENT[Cloud Agent Session]
    end

    GH_PR --> GH_WH
    GH_WH --> WH_ROUTE
    WH_ROUTE --> PR_HANDLER
    PR_HANDLER --> CREATE_REVIEW
    PR_HANDLER --> DISPATCH
    DISPATCH --> PREPARE
    PREPARE --> PROMPT
    PREPARE --> CF_WORKER
    CF_WORKER --> ORCHESTRATOR
    ORCHESTRATOR --> AGENT
    AGENT -->|gh CLI| GitHub
```

## Target Architecture (GitLab)

```mermaid
flowchart TD
    subgraph GitLab
        GL_MR[Merge Request Event]
        GL_WH[Webhook POST]
    end

    subgraph Kilo Backend
        WH_ROUTE_GL[/api/webhooks/gitlab/route.ts]
        MR_HANDLER[merge-request-handler.ts]
        CREATE_REVIEW[createCodeReview]
        DISPATCH[tryDispatchPendingReviews]
        PREPARE_GL[prepareReviewPayload - GitLab]
        PROMPT_GL[generateReviewPrompt - GitLab]
    end

    subgraph Cloudflare Worker
        CF_WORKER[Code Review Worker]
        ORCHESTRATOR[CodeReviewOrchestrator DO]
    end

    subgraph Cloud Agent
        AGENT[Cloud Agent Session]
    end

    GL_MR --> GL_WH
    GL_WH --> WH_ROUTE_GL
    WH_ROUTE_GL --> MR_HANDLER
    MR_HANDLER --> CREATE_REVIEW
    MR_HANDLER --> DISPATCH
    DISPATCH --> PREPARE_GL
    PREPARE_GL --> PROMPT_GL
    PREPARE_GL --> CF_WORKER
    CF_WORKER --> ORCHESTRATOR
    ORCHESTRATOR --> AGENT
    AGENT -->|glab CLI| GitLab
```

## Implementation Phases

### Phase 1: Webhook Endpoint and Event Handling

#### 1.1 Create GitLab Webhook Route

**File:** `src/app/api/webhooks/gitlab/route.ts`

- Create new webhook endpoint at `/api/webhooks/gitlab`
- Implement GitLab webhook signature verification using `X-Gitlab-Token` header
- Parse GitLab webhook payload structure
- Route events to appropriate handlers

**Key differences from GitHub:**

- GitLab uses a simple secret token in `X-Gitlab-Token` header (not HMAC signature)
- Event type is in `X-Gitlab-Event` header
- Payload structure differs significantly

#### 1.2 Create GitLab Webhook Schemas

**File:** `src/lib/integrations/platforms/gitlab/webhook-schemas.ts`

Define Zod schemas for GitLab webhook payloads:

- `MergeRequestPayloadSchema` - for MR events
- `PushPayloadSchema` - for push events (future use)
- `NotePayloadSchema` - for comment events (future use)

**GitLab MR Webhook Payload Structure:**

```typescript
type GitLabMergeRequestPayload = {
  object_kind: 'merge_request';
  event_type: 'merge_request';
  user: { id: number; username: string; name: string; email: string };
  project: {
    id: number;
    name: string;
    path_with_namespace: string;
    web_url: string;
    default_branch: string;
  };
  object_attributes: {
    id: number;
    iid: number; // Internal ID - equivalent to PR number
    title: string;
    description: string;
    state: 'opened' | 'closed' | 'merged';
    action: 'open' | 'close' | 'reopen' | 'update' | 'merge';
    source_branch: string;
    target_branch: string;
    last_commit: { id: string; message: string };
    url: string;
    work_in_progress: boolean;
    draft: boolean;
  };
  repository: { name: string; url: string };
};
```

#### 1.3 Create GitLab Webhook Handlers

**File:** `src/lib/integrations/platforms/gitlab/webhook-handlers/merge-request-handler.ts`

- Handle MR events: `open`, `update`, `reopen`
- Skip draft MRs
- Check agent config for GitLab platform
- Create code review record
- Trigger dispatch

### Phase 2: GitLab Adapter Extensions

#### 2.1 Extend GitLab Adapter

**File:** `src/lib/integrations/platforms/gitlab/adapter.ts`

Add new functions:

- `verifyGitLabWebhookToken(token: string, expectedToken: string): boolean`
- `findKiloReviewNote(accessToken, projectId, mrIid)` - Find existing Kilo review comment
- `fetchMRInlineComments(accessToken, projectId, mrIid)` - Get existing inline comments
- `getMRHeadCommit(accessToken, projectId, mrIid)` - Get latest commit SHA
- `addReactionToMR(accessToken, projectId, mrIid, reaction)` - Add emoji reaction

**GitLab API Endpoints:**

- Notes: `GET /projects/:id/merge_requests/:iid/notes`
- Discussions: `GET /projects/:id/merge_requests/:iid/discussions`
- MR Details: `GET /projects/:id/merge_requests/:iid`

### Phase 3: Platform-Agnostic Prompt Generation

#### 3.1 Refactor Prompt Generation

**File:** `src/lib/code-reviews/prompts/generate-prompt.ts`

Create platform-aware prompt generation:

```typescript
type Platform = 'github' | 'gitlab';

export async function generateReviewPrompt(
  config: CodeReviewAgentConfig,
  repository: string,
  prNumber?: number,
  reviewId?: string,
  existingReviewState?: ExistingReviewState | null,
  platform: Platform = 'github' // New parameter
): Promise<{ prompt: string; version: string; source: string }>;
```

#### 3.2 Create GitLab Prompt Template

**File:** `src/lib/code-reviews/prompts/default-prompt-template-gitlab.json`

Key differences from GitHub template:

- Use `glab` CLI instead of `gh` CLI
- Different API endpoints for comments
- Different MR terminology (MR vs PR, iid vs number)

**GitLab-specific commands:**

```bash
# View MR diff
glab mr diff {MR_IID}

# Post comment on MR
glab api projects/{PROJECT_ID}/merge_requests/{MR_IID}/notes -X POST -f body="comment"

# Post inline comment (discussion)
glab api projects/{PROJECT_ID}/merge_requests/{MR_IID}/discussions -X POST \
  -f body="comment" \
  -f position[base_sha]="..." \
  -f position[head_sha]="..." \
  -f position[start_sha]="..." \
  -f position[position_type]="text" \
  -f position[new_path]="file.ts" \
  -f position[new_line]=42
```

#### 3.3 Create Platform Helper

**File:** `src/lib/code-reviews/prompts/platform-helpers.ts`

```typescript
export function getPlatformConfig(platform: Platform) {
  return {
    github: {
      cli: 'gh',
      prTerm: 'PR',
      prNumberField: 'number',
      diffCommand: 'gh pr diff {PR_NUMBER}',
      // ... more config
    },
    gitlab: {
      cli: 'glab',
      prTerm: 'MR',
      prNumberField: 'iid',
      diffCommand: 'glab mr diff {MR_IID}',
      // ... more config
    },
  }[platform];
}
```

### Phase 4: Dispatch and Payload Preparation

#### 4.1 Update Dispatch Logic

**File:** `src/lib/code-reviews/dispatch/dispatch-pending-reviews.ts`

Modify [`dispatchReview()`](src/lib/code-reviews/dispatch/dispatch-pending-reviews.ts:151) to:

- Detect platform from review record or integration
- Pass platform to `getAgentConfigForOwner()`
- Pass platform to `prepareReviewPayload()`

#### 4.2 Update Payload Preparation

**File:** `src/lib/code-reviews/triggers/prepare-review-payload.ts`

Modify [`prepareReviewPayload()`](src/lib/code-reviews/triggers/prepare-review-payload.ts:60) to:

- Accept platform parameter
- Use GitLab adapter functions for GitLab reviews
- Generate GitLab-specific prompt
- Include GitLab token instead of GitHub token

**New SessionInput for GitLab:**

```typescript
interface SessionInput {
  gitlabRepo?: string; // For GitLab: "group/project"
  githubRepo?: string; // For GitHub: "owner/repo"
  kilocodeOrganizationId?: string;
  prompt: string;
  mode: 'code';
  model: string;
  upstreamBranch: string;
  gitlabToken?: string; // For GitLab
  githubToken?: string; // For GitHub
}
```

### Phase 5: Database Schema Updates

#### 5.1 Add Platform Column to Code Reviews

**Migration:** Add `platform` column to `cloud_agent_code_reviews` table

```sql
ALTER TABLE cloud_agent_code_reviews
ADD COLUMN platform text NOT NULL DEFAULT 'github';
```

This allows tracking which platform each review is for.

#### 5.2 Update Agent Configs

The `agent_configs` table already supports platform-specific configs via the `platform` column. Ensure GitLab configs can be created.

### Phase 6: Constants and Types

#### 6.1 Add GitLab Constants

**File:** `src/lib/integrations/core/constants.ts`

```typescript
export const GITLAB_EVENT = {
  MERGE_REQUEST: 'Merge Request Hook',
  PUSH: 'Push Hook',
  NOTE: 'Note Hook',
  // ... more events
} as const;

export const GITLAB_ACTION = {
  OPEN: 'open',
  CLOSE: 'close',
  REOPEN: 'reopen',
  UPDATE: 'update',
  MERGE: 'merge',
  // ... more actions
} as const;
```

### Phase 7: Environment Configuration

#### 7.1 Add GitLab Webhook Secret

**Files:** `.env.example`, environment configuration

```env
GITLAB_WEBHOOK_SECRET=your-webhook-secret-token
```

This secret will be used to verify incoming GitLab webhooks.

### Phase 8: Cloud Agent Updates

#### 8.1 Ensure glab CLI Support

The cloud agent environment needs the `glab` CLI installed and configured. This may require:

- Adding `glab` to the cloud agent Docker image
- Configuring `GITLAB_TOKEN` environment variable in sessions

### Phase 9: UI Updates (Future Enhancement)

#### 9.1 Code Reviews Page

**File:** `src/app/(app)/code-reviews/ReviewAgentPageClient.tsx`

- Add GitLab integration option alongside GitHub
- Show GitLab-specific setup instructions
- Display webhook URL for manual configuration

#### 9.2 Webhook Setup Instructions

Provide clear instructions for users to configure GitLab webhooks:

1. Go to Project Settings > Webhooks
2. Add URL: `https://kilo.ai/api/webhooks/gitlab`
3. Set Secret Token
4. Select events: Merge Request events
5. Enable SSL verification

---

## Implementation Order (Recommended)

### Sprint 1: Core Webhook Infrastructure

1. Create GitLab webhook route (`/api/webhooks/gitlab`)
2. Create GitLab webhook schemas
3. Create merge request handler
4. Add GitLab constants

### Sprint 2: GitLab Adapter Extensions

5. Add webhook verification to GitLab adapter
6. Add MR comment/note functions
7. Add reaction function

### Sprint 3: Platform-Agnostic Prompt Generation

8. Create platform helper
9. Create GitLab prompt template
10. Refactor `generateReviewPrompt()` for platform support

### Sprint 4: Dispatch and Payload

11. Update dispatch logic for platform awareness
12. Update payload preparation for GitLab
13. Add platform column to database

### Sprint 5: Integration Testing

14. Test E2E flow with manual webhook configuration
15. Verify code review comments appear on GitLab MRs

---

## File Changes Summary

### New Files

| File                                                                              | Purpose                         |
| --------------------------------------------------------------------------------- | ------------------------------- |
| `src/app/api/webhooks/gitlab/route.ts`                                            | GitLab webhook endpoint         |
| `src/lib/integrations/platforms/gitlab/webhook-schemas.ts`                        | Zod schemas for GitLab webhooks |
| `src/lib/integrations/platforms/gitlab/webhook-handlers/index.ts`                 | Handler exports                 |
| `src/lib/integrations/platforms/gitlab/webhook-handlers/merge-request-handler.ts` | MR event handler                |
| `src/lib/code-reviews/prompts/default-prompt-template-gitlab.json`                | GitLab-specific prompt          |
| `src/lib/code-reviews/prompts/platform-helpers.ts`                                | Platform configuration helper   |

### Modified Files

| File                                                        | Changes                                        |
| ----------------------------------------------------------- | ---------------------------------------------- |
| `src/lib/integrations/platforms/gitlab/adapter.ts`          | Add webhook verification, MR comment functions |
| `src/lib/integrations/core/constants.ts`                    | Add GitLab event/action constants              |
| `src/lib/code-reviews/prompts/generate-prompt.ts`           | Add platform parameter, use platform helper    |
| `src/lib/code-reviews/dispatch/dispatch-pending-reviews.ts` | Pass platform to payload preparation           |
| `src/lib/code-reviews/triggers/prepare-review-payload.ts`   | Support GitLab token and prompt                |
| `src/db/schema.ts`                                          | Add platform column to code reviews table      |

---

## Future Enhancements (Out of Scope for MVP)

1. **Auto-configure webhooks via API** - Use GitLab API to automatically set up webhooks
2. **Group-level webhooks** - Support webhooks at the GitLab group level for multiple projects
3. **Self-hosted GitLab** - Full support for self-hosted instances with custom URLs
4. **GitLab CI/CD integration** - Trigger reviews from CI pipelines
5. **Approval rules** - Integrate with GitLab's approval workflow
6. **Project Access Tokens** - Support for project-scoped tokens instead of user OAuth

---

## Testing Strategy

### Manual Testing Checklist

- [ ] Configure GitLab webhook manually on a test project
- [ ] Open a new MR and verify webhook is received
- [ ] Verify code review record is created in database
- [ ] Verify review is dispatched to cloud agent
- [ ] Verify inline comments appear on MR
- [ ] Verify summary comment is posted
- [ ] Test MR update (new commits) triggers new review
- [ ] Test draft MR is skipped

### Integration Tests

- [ ] Webhook signature verification
- [ ] Payload parsing
- [ ] Handler routing
- [ ] Prompt generation for GitLab

---

## Risk Assessment

| Risk                                    | Mitigation                                                |
| --------------------------------------- | --------------------------------------------------------- |
| `glab` CLI not available in cloud agent | Verify cloud agent image includes glab, or add it         |
| GitLab API rate limits                  | Implement backoff, use efficient API calls                |
| Different GitLab versions (self-hosted) | Start with GitLab.com only, document version requirements |
| OAuth token expiration during review    | Implement token refresh before review starts              |

---

## Dependencies

- Existing GitLab OAuth integration (already implemented)
- Cloud agent with `glab` CLI support
- GitLab API v4 compatibility
