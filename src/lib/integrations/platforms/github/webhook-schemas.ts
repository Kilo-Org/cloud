import * as z from 'zod';

/**
 * Zod schemas for GitHub webhook payload validation
 * These ensure we receive the expected data structure from GitHub
 */

// Common schemas used across multiple webhook types
const GitHubAccountSchema = z.object({
  id: z.number(),
  login: z.string(),
  type: z.string().optional(),
});

const GitHubRequesterSchema = z.object({
  id: z.number(),
  login: z.string(),
});

const GitHubInstallationSchema = z.object({
  id: z.number(),
  account: GitHubAccountSchema,
  repository_selection: z.string(),
  permissions: z.record(z.string(), z.unknown()),
  events: z.array(z.string()).optional(),
  created_at: z.string(),
});

const GitHubSenderSchema = z.object({
  login: z.string(),
});

// installation.created webhook payload
export const InstallationCreatedPayloadSchema = z.object({
  action: z.literal('created'),
  installation: GitHubInstallationSchema,
  requester: GitHubRequesterSchema.nullable().optional(),
  sender: GitHubSenderSchema.optional(),
});

// installation.deleted webhook payload
export const InstallationDeletedPayloadSchema = z.object({
  action: z.literal('deleted'),
  installation: z.object({
    id: z.number(),
  }),
  sender: GitHubSenderSchema.optional(),
});

// installation.suspend webhook payload
export const InstallationSuspendPayloadSchema = z.object({
  action: z.literal('suspend'),
  installation: z.object({
    id: z.number(),
  }),
  sender: GitHubSenderSchema.optional(),
});

// installation.unsuspend webhook payload
export const InstallationUnsuspendPayloadSchema = z.object({
  action: z.literal('unsuspend'),
  installation: z.object({
    id: z.number(),
  }),
  sender: GitHubSenderSchema.optional(),
});

// installation_repositories webhook payload
export const InstallationRepositoriesPayloadSchema = z.object({
  action: z.enum(['added', 'removed']),
  installation: z.object({
    id: z.number(),
  }),
  repositories_added: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        full_name: z.string(),
        private: z.boolean(),
      })
    )
    .optional(),
  repositories_removed: z
    .array(
      z.object({
        id: z.number(),
        name: z.string(),
        full_name: z.string(),
        private: z.boolean(),
      })
    )
    .optional(),
});

// push webhook payload
export const PushEventPayloadSchema = z.object({
  ref: z.string(),
  repository: z.object({
    full_name: z.string(),
  }),
  deleted: z.boolean(),
});

// pull_request webhook payload
const GitHubRepositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean().optional(),
  owner: z.object({
    login: z.string(),
  }),
});

export const PullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    title: z.string(),
    body: z.string().nullable().optional(),
    state: z.string(),
    draft: z.boolean().optional(),
    html_url: z.string().optional(),
    user: z.object({
      id: z.number(),
      login: z.string(),
      avatar_url: z.string(),
    }),
    head: z.object({
      sha: z.string(),
      ref: z.string(),
      repo: z
        .object({
          full_name: z.string(),
        })
        .nullable()
        .optional(),
    }),
    base: z.object({
      sha: z.string(),
      ref: z.string(),
    }),
  }),
  repository: GitHubRepositorySchema,
  installation: z.object({
    id: z.number(),
  }),
  sender: GitHubSenderSchema.optional(),
});

// issues webhook payload
export const IssuePayloadSchema = z.object({
  action: z.string(),
  issue: z.object({
    number: z.number(),
    html_url: z.string(),
    title: z.string(),
    body: z.string().nullable().optional(),
    user: z.object({
      login: z.string(),
      type: z.string().optional(),
    }),
    labels: z
      .array(
        z.union([
          z.string(),
          z.object({
            name: z.string(),
          }),
        ])
      )
      .optional(),
  }),
  // Label field is present for "labeled" and "unlabeled" actions
  label: z
    .object({
      name: z.string(),
      color: z.string().optional(),
    })
    .optional(),
  repository: GitHubRepositorySchema,
  installation: z.object({
    id: z.number(),
  }),
  sender: z.object({
    login: z.string(),
    type: z.string().optional(),
  }),
});

// Type exports for use in the webhook handler
export type InstallationCreatedPayload = z.infer<typeof InstallationCreatedPayloadSchema>;
export type InstallationDeletedPayload = z.infer<typeof InstallationDeletedPayloadSchema>;
export type InstallationSuspendPayload = z.infer<typeof InstallationSuspendPayloadSchema>;
export type InstallationUnsuspendPayload = z.infer<typeof InstallationUnsuspendPayloadSchema>;
export type InstallationRepositoriesPayload = z.infer<typeof InstallationRepositoriesPayloadSchema>;
export type PushEventPayload = z.infer<typeof PushEventPayloadSchema>;
export type PullRequestPayload = z.infer<typeof PullRequestPayloadSchema>;
export type IssuePayload = z.infer<typeof IssuePayloadSchema>;
