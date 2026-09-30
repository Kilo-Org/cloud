/**
 * GitLab Webhook Payload Schemas
 *
 * Zod schemas for validating GitLab webhook payloads.
 * Reference: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html
 */

import { z } from 'zod';

/**
 * GitLab User schema (common across events)
 */
const GitLabUserSchema = z.object({
  id: z.number(),
  name: z.string(),
  username: z.string(),
  email: z.string().optional(),
  avatar_url: z.string().optional(),
});

/**
 * GitLab Project schema (common across events)
 */
const GitLabProjectSchema = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string().nullable().optional(),
  web_url: z.string(),
  avatar_url: z.string().nullable().optional(),
  git_ssh_url: z.string().optional(),
  git_http_url: z.string().optional(),
  namespace: z.string(),
  visibility_level: z.number().optional(),
  path_with_namespace: z.string(),
  default_branch: z.string(),
  homepage: z.string().optional(),
  url: z.string().optional(),
  ssh_url: z.string().optional(),
  http_url: z.string().optional(),
});

/**
 * GitLab Repository schema
 */
const GitLabRepositorySchema = z.object({
  name: z.string(),
  url: z.string(),
  description: z.string().nullable().optional(),
  homepage: z.string().optional(),
});

/**
 * GitLab Commit schema
 */
const GitLabCommitSchema = z.object({
  id: z.string(),
  message: z.string(),
  title: z.string().optional(),
  timestamp: z.string().optional(),
  url: z.string().optional(),
  author: z
    .object({
      name: z.string(),
      email: z.string(),
    })
    .optional(),
});

/**
 * GitLab Label schema
 */
const GitLabLabelSchema = z.object({
  id: z.number(),
  title: z.string(),
  color: z.string(),
  project_id: z.number().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  template: z.boolean().optional(),
  description: z.string().nullable().optional(),
  type: z.string().optional(),
  group_id: z.number().nullable().optional(),
});

/**
 * Merge Request object attributes schema
 */
const MergeRequestObjectAttributesSchema = z.object({
  id: z.number(),
  iid: z.number(), // Internal ID - equivalent to PR number
  title: z.string(),
  description: z.string().nullable().optional(),
  state: z.enum(['opened', 'closed', 'merged', 'locked']),
  action: z
    .enum([
      'open',
      'close',
      'reopen',
      'update',
      'merge',
      'approved',
      'unapproved',
      'approval',
      'unapproval',
    ])
    .optional(),
  source_branch: z.string(),
  target_branch: z.string(),
  source_project_id: z.number(),
  target_project_id: z.number(),
  author_id: z.number(),
  assignee_id: z.number().nullable().optional(),
  assignee_ids: z.array(z.number()).optional(),
  reviewer_ids: z.array(z.number()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
  merged_at: z.string().nullable().optional(),
  closed_at: z.string().nullable().optional(),
  last_edited_at: z.string().nullable().optional(),
  last_edited_by_id: z.number().nullable().optional(),
  milestone_id: z.number().nullable().optional(),
  merge_status: z.string().optional(),
  detailed_merge_status: z.string().optional(),
  merge_error: z.string().nullable().optional(),
  merge_user_id: z.number().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  squash_commit_sha: z.string().nullable().optional(),
  head_pipeline_id: z.number().nullable().optional(),
  work_in_progress: z.boolean().optional(),
  draft: z.boolean().optional(),
  url: z.string(),
  source: z.object({ path_with_namespace: z.string() }).optional(),
  target: z.object({ path_with_namespace: z.string() }).optional(),
  last_commit: GitLabCommitSchema.optional(),
  labels: z.array(GitLabLabelSchema).optional(),
  blocking_discussions_resolved: z.boolean().optional(),
  first_contribution: z.boolean().optional(),
});

/**
 * Merge Request Webhook Payload Schema
 * Triggered when a merge request is created, updated, merged, or closed
 */
export const MergeRequestPayloadSchema = z.object({
  object_kind: z.literal('merge_request'),
  event_type: z.literal('merge_request'),
  user: GitLabUserSchema,
  project: GitLabProjectSchema,
  repository: GitLabRepositorySchema.optional(),
  object_attributes: MergeRequestObjectAttributesSchema,
  labels: z.array(GitLabLabelSchema).optional(),
  changes: z
    .object({
      title: z
        .object({
          previous: z.string().optional(),
          current: z.string().optional(),
        })
        .optional(),
      description: z
        .object({
          previous: z.string().nullable().optional(),
          current: z.string().nullable().optional(),
        })
        .optional(),
      draft: z
        .object({
          previous: z.boolean().optional(),
          current: z.boolean().optional(),
        })
        .optional(),
      labels: z
        .object({
          previous: z.array(GitLabLabelSchema).optional(),
          current: z.array(GitLabLabelSchema).optional(),
        })
        .optional(),
    })
    .optional(),
  assignees: z.array(GitLabUserSchema).optional(),
  reviewers: z.array(GitLabUserSchema).optional(),
});

export type MergeRequestPayload = z.infer<typeof MergeRequestPayloadSchema>;

/**
 * Push Event Webhook Payload Schema
 * Triggered when commits are pushed to a repository
 */
export const PushEventPayloadSchema = z.object({
  object_kind: z.literal('push'),
  event_name: z.literal('push').optional(),
  before: z.string(),
  after: z.string(),
  ref: z.string(),
  ref_protected: z.boolean().optional(),
  checkout_sha: z.string().nullable().optional(),
  user_id: z.number(),
  user_name: z.string(),
  user_username: z.string(),
  user_email: z.string().optional(),
  user_avatar: z.string().optional(),
  project_id: z.number(),
  project: GitLabProjectSchema,
  repository: GitLabRepositorySchema,
  commits: z.array(
    z.object({
      id: z.string(),
      message: z.string(),
      title: z.string().optional(),
      timestamp: z.string(),
      url: z.string(),
      author: z.object({
        name: z.string(),
        email: z.string(),
      }),
      added: z.array(z.string()).optional(),
      modified: z.array(z.string()).optional(),
      removed: z.array(z.string()).optional(),
    })
  ),
  total_commits_count: z.number(),
});

export type PushEventPayload = z.infer<typeof PushEventPayloadSchema>;

/**
 * Note (Comment) Event Webhook Payload Schema
 * Triggered when a comment is made on a commit, merge request, issue, or snippet
 */
export const NoteEventPayloadSchema = z.object({
  object_kind: z.literal('note'),
  event_type: z.literal('note'),
  user: GitLabUserSchema,
  project_id: z.number(),
  project: GitLabProjectSchema,
  repository: GitLabRepositorySchema.optional(),
  object_attributes: z.object({
    id: z.number(),
    note: z.string(),
    noteable_type: z.enum(['Commit', 'MergeRequest', 'Issue', 'Snippet']),
    author_id: z.number(),
    created_at: z.string(),
    updated_at: z.string(),
    project_id: z.number(),
    attachment: z.string().nullable().optional(),
    line_code: z.string().nullable().optional(),
    commit_id: z.string().nullable().optional(),
    noteable_id: z.number().nullable().optional(),
    system: z.boolean().optional(),
    st_diff: z
      .object({
        diff: z.string().optional(),
        new_path: z.string().optional(),
        old_path: z.string().optional(),
        a_mode: z.string().optional(),
        b_mode: z.string().optional(),
        new_file: z.boolean().optional(),
        renamed_file: z.boolean().optional(),
        deleted_file: z.boolean().optional(),
      })
      .nullable()
      .optional(),
    url: z.string(),
    type: z.string().nullable().optional(),
    position: z
      .object({
        base_sha: z.string().optional(),
        start_sha: z.string().optional(),
        head_sha: z.string().optional(),
        old_path: z.string().optional(),
        new_path: z.string().optional(),
        position_type: z.string().optional(),
        old_line: z.number().nullable().optional(),
        new_line: z.number().nullable().optional(),
        line_range: z
          .object({
            start: z
              .object({
                line_code: z.string().optional(),
                type: z.string().optional(),
                old_line: z.number().nullable().optional(),
                new_line: z.number().nullable().optional(),
              })
              .optional(),
            end: z
              .object({
                line_code: z.string().optional(),
                type: z.string().optional(),
                old_line: z.number().nullable().optional(),
                new_line: z.number().nullable().optional(),
              })
              .optional(),
          })
          .nullable()
          .optional(),
      })
      .nullable()
      .optional(),
  }),
  merge_request: MergeRequestObjectAttributesSchema.optional(),
});

export type NoteEventPayload = z.infer<typeof NoteEventPayloadSchema>;

/**
 * Pipeline Event Webhook Payload Schema (for future use)
 */
export const PipelineEventPayloadSchema = z.object({
  object_kind: z.literal('pipeline'),
  object_attributes: z.object({
    id: z.number(),
    iid: z.number(),
    ref: z.string(),
    tag: z.boolean(),
    sha: z.string(),
    before_sha: z.string(),
    source: z.string(),
    status: z.string(),
    detailed_status: z.string().optional(),
    stages: z.array(z.string()).optional(),
    created_at: z.string(),
    finished_at: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
    queued_duration: z.number().nullable().optional(),
    variables: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  }),
  merge_request: z
    .object({
      id: z.number(),
      iid: z.number(),
      title: z.string(),
      source_branch: z.string(),
      source_project_id: z.number(),
      target_branch: z.string(),
      target_project_id: z.number(),
      state: z.string(),
      merge_status: z.string().optional(),
      detailed_merge_status: z.string().optional(),
      url: z.string(),
    })
    .nullable()
    .optional(),
  user: GitLabUserSchema,
  project: GitLabProjectSchema,
  commit: GitLabCommitSchema.optional(),
  source_pipeline: z
    .object({
      project: z.object({ id: z.number(), web_url: z.string(), path_with_namespace: z.string() }),
      pipeline_id: z.number(),
      job_id: z.number(),
    })
    .nullable()
    .optional(),
  builds: z
    .array(
      z.object({
        id: z.number(),
        stage: z.string(),
        name: z.string(),
        status: z.string(),
        created_at: z.string(),
        started_at: z.string().nullable().optional(),
        finished_at: z.string().nullable().optional(),
        duration: z.number().nullable().optional(),
        queued_duration: z.number().nullable().optional(),
        failure_reason: z.string().nullable().optional(),
        when: z.string().optional(),
        manual: z.boolean().optional(),
        allow_failure: z.boolean().optional(),
        user: GitLabUserSchema.optional(),
        runner: z
          .object({
            id: z.number(),
            description: z.string(),
            runner_type: z.string().optional(),
            active: z.boolean().optional(),
            tags: z.array(z.string()).optional(),
          })
          .nullable()
          .optional(),
        artifacts_file: z
          .object({
            filename: z.string().optional(),
            size: z.number().optional(),
          })
          .nullable()
          .optional(),
        environment: z
          .object({
            name: z.string(),
            action: z.string().optional(),
            deployment_tier: z.string().optional(),
          })
          .nullable()
          .optional(),
      })
    )
    .optional(),
});

export type PipelineEventPayload = z.infer<typeof PipelineEventPayloadSchema>;
