import * as z from 'zod';
import { agentModeSchema, mcpServerConfigSchema } from '@/routers/cloud-agent-schemas';

/**
 * Schema for callback target configuration.
 * Allows users to specify a webhook URL to receive execution completion events.
 */
export const callbackTargetSchema = z.object({
  url: z.string().url('Callback URL must be a valid URL'),
  headers: z.record(z.string(), z.string()).optional(),
});

/**
 * Public API schema for preparing a cloud agent session.
 *
 * This is a subset of the internal prepareSession schema - users cannot
 * supply their own GitHub/GitLab tokens (those are enriched by the backend).
 *
 * Must provide either `githubRepo` OR `gitlabProject`, but not both.
 */
export const publicPrepareSessionSchema = z
  .object({
    // Required fields
    prompt: z
      .string()
      .min(1, 'Prompt is required')
      .max(100_000, 'Prompt must be at most 100,000 characters'),
    mode: agentModeSchema,
    model: z.string().min(1, 'Model is required'),

    // Repository source (mutually exclusive - must provide exactly one)
    githubRepo: z
      .string()
      .regex(
        /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
        'Invalid repository format. Expected: owner/repo'
      )
      .optional(),
    gitlabProject: z
      .string()
      .regex(
        /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/,
        'Invalid project path format. Expected: group/project or group/subgroup/project'
      )
      .optional()
      .describe('GitLab project path (e.g., group/project or group/subgroup/project)'),

    // Optional organization context
    organizationId: z.string().uuid('Invalid organization ID format').optional(),

    // Optional environment profile
    // If provided, envVars and setupCommands from the profile will be used.
    // Any inline envVars/setupCommands will be merged (inline takes precedence).
    // If organizationId is provided, looks up org profile; otherwise looks up user profile.
    profileName: z.string().max(100, 'Profile name must be at most 100 characters').optional(),

    // Optional configuration
    envVars: z
      .record(
        z.string().max(256, 'Environment variable key must be at most 256 characters'),
        z.string().max(256, 'Environment variable value must be at most 256 characters')
      )
      .refine(obj => Object.keys(obj).length <= 50, {
        message: 'Maximum 50 environment variables allowed',
      })
      .optional(),
    setupCommands: z
      .array(z.string().max(500, 'Setup command must be at most 500 characters'))
      .max(20, 'Maximum 20 setup commands allowed')
      .optional(),
    mcpServers: z
      .record(
        z.string().max(100, 'MCP server name must be at most 100 characters'),
        mcpServerConfigSchema
      )
      .refine(obj => Object.keys(obj).length <= 10, {
        message: 'Maximum 10 MCP servers allowed',
      })
      .optional(),
    autoCommit: z.boolean().optional(),
    upstreamBranch: z
      .string()
      .max(256, 'Upstream branch must be at most 256 characters')
      .optional(),
    callbackTarget: callbackTargetSchema.optional(),
  })
  .refine(
    data => (data.githubRepo || data.gitlabProject) && !(data.githubRepo && data.gitlabProject),
    {
      message: 'Must provide either githubRepo or gitlabProject, but not both',
      path: ['githubRepo'],
    }
  );

export type PublicPrepareSessionInput = z.infer<typeof publicPrepareSessionSchema>;

/**
 * Response schema for the public prepareSession endpoint.
 */
export const publicPrepareSessionResponseSchema = z.object({
  kiloSessionId: z.string().uuid(),
  cloudAgentSessionId: z.string(),
  ticket: z.string(),
  expiresAt: z.number(),
});

export type PublicPrepareSessionResponse = z.infer<typeof publicPrepareSessionResponseSchema>;
