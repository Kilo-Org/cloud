import { tool } from '@kilocode/plugin';
import type { MayorGastownClient } from './client';

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `"${label}" must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Mayor-specific tools for cross-rig delegation.
 * These are only registered when `GASTOWN_AGENT_ROLE=mayor`.
 */
export function createMayorTools(client: MayorGastownClient) {
  return {
    gt_sling: tool({
      description:
        'Delegate a task to a polecat agent in a specific rig. ' +
        'Creates a bead (work item), assigns a polecat, and arms the dispatch alarm. ' +
        'The polecat will be started automatically and begin working on the task. ' +
        'You must specify which rig the work belongs to — use gt_list_rigs first if unsure.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to assign work to'),
        title: tool.schema.string().describe('Short title describing the task'),
        body: tool.schema
          .string()
          .describe(
            'Detailed description of the work to be done. Include requirements, context, acceptance criteria.'
          )
          .optional(),
        metadata: tool.schema
          .string()
          .describe('JSON-encoded metadata object for additional context')
          .optional(),
      },
      async execute(args) {
        const metadata = args.metadata ? parseJsonObject(args.metadata, 'metadata') : undefined;
        const result = await client.sling({
          rig_id: args.rig_id,
          title: args.title,
          body: args.body,
          metadata,
        });
        return [
          `Task slung successfully.`,
          `Bead: ${result.bead.bead_id} — "${result.bead.title}"`,
          `Assigned to: ${result.agent.name} (${result.agent.role}, id: ${result.agent.id})`,
          `Status: ${result.bead.status}`,
          `The polecat will be dispatched automatically by the alarm scheduler.`,
        ].join('\n');
      },
    }),

    gt_list_rigs: tool({
      description:
        'List all rigs (repositories) in your town. ' +
        'Returns the rig ID, name, git URL, and default branch for each rig. ' +
        'Use this to discover available rigs before delegating work with gt_sling.',
      args: {},
      async execute() {
        const rigs = await client.listRigs();
        if (rigs.length === 0) {
          return 'No rigs configured in this town. A rig must be created before work can be delegated.';
        }
        return JSON.stringify(rigs, null, 2);
      },
    }),

    gt_list_beads: tool({
      description:
        'List beads (work items) in a specific rig. ' +
        'Optionally filter by status (open, in_progress, in_review, closed, failed) or type (issue, message, escalation, merge_request). ' +
        'Use this to check what work exists in a rig, what is in progress, and what has been completed.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to list beads from'),
        status: tool.schema
          .enum(['open', 'in_progress', 'in_review', 'closed', 'failed'])
          .describe('Filter by bead status')
          .optional(),
        type: tool.schema
          .enum(['issue', 'message', 'escalation', 'merge_request'])
          .describe('Filter by bead type')
          .optional(),
      },
      async execute(args) {
        const beads = await client.listBeads(args.rig_id, {
          status: args.status,
          type: args.type,
        });
        if (beads.length === 0) {
          return 'No beads found matching the filter.';
        }
        return JSON.stringify(beads, null, 2);
      },
    }),

    gt_list_agents: tool({
      description:
        'List all agents in a specific rig. ' +
        'Returns agent ID, role, name, status, and current hook (assigned bead). ' +
        'Use this to see which agents are active, idle, or working on what.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to list agents from'),
      },
      async execute(args) {
        const agents = await client.listAgents(args.rig_id);
        if (agents.length === 0) {
          return 'No agents registered in this rig.';
        }
        return JSON.stringify(agents, null, 2);
      },
    }),

    gt_sling_batch: tool({
      description:
        'Sling multiple beads as a tracked convoy. Use this when a task should be broken ' +
        'into parallel sub-tasks that you want to track as a group. Creates N beads + 1 convoy, ' +
        'assigns polecats, and dispatches all in one call. Use gt_list_convoys to check progress later.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to assign work to'),
        convoy_title: tool.schema
          .string()
          .describe('Title for the convoy — describes the overall task being decomposed'),
        tasks: tool.schema
          .array(
            tool.schema.object({
              title: tool.schema.string().describe('Short title describing the sub-task'),
              body: tool.schema
                .string()
                .describe('Detailed requirements for the sub-task')
                .optional(),
              depends_on: tool.schema
                .array(tool.schema.number().int().min(0))
                .describe(
                  'Zero-based indices of tasks in this array that must complete before this task can start. ' +
                    'Example: [0] means this task depends on the first task. Omit or use [] for tasks with no dependencies.'
                )
                .optional(),
            })
          )
          .min(1)
          .describe('Array of sub-tasks to create as beads in the convoy'),
        merge_mode: tool.schema
          .enum(['review-then-land', 'review-and-merge'])
          .describe(
            'Controls how completed beads are handled:\n' +
              '- "review-then-land" (default): Each bead is reviewed by the refinery and merged into the convoy feature branch. ' +
              'Only at the end of the convoy does a PR or merge into main occur. Best for tightly coupled work where ' +
              'intermediate PRs would be noisy or where tasks build on each other.\n' +
              '- "review-and-merge": Each bead goes through the full review + merge/PR cycle independently. ' +
              'Best for loosely coupled tasks where each bead stands on its own and you want incremental merges.'
          )
          .optional(),
        parallel: tool.schema
          .boolean()
          .describe(
            'Set to true ONLY when ALL tasks are genuinely independent — they touch completely ' +
              'different files with no shared state. Without this flag, the system REQUIRES at least ' +
              'one task to declare depends_on. This prevents accidental parallel execution of tasks ' +
              'that need ordering, which causes merge conflicts and failures.'
          )
          .optional(),
      },
      async execute(args) {
        const result = await client.slingBatch({
          rig_id: args.rig_id,
          convoy_title: args.convoy_title,
          tasks: args.tasks,
          merge_mode: args.merge_mode,
          parallel: args.parallel,
        });

        const beadLines = result.beads.map(
          (b: { bead: { title: string }; agent: { name: string; id: string } }, i: number) =>
            `  ${i + 1}. "${b.bead.title}" → ${b.agent.name} (${b.agent.id})`
        );
        const mode = args.merge_mode ?? 'review-then-land';
        return [
          `Convoy created: "${result.convoy.title}" (${result.convoy.id})`,
          `Merge mode: ${mode}`,
          `Tracking ${result.convoy.total_beads} beads:`,
          ...beadLines,
          mode === 'review-then-land'
            ? `Beads will be reviewed and merged into the convoy feature branch. A final PR/merge to main occurs when all beads are done.`
            : `Each bead will go through the full review + merge/PR cycle independently.`,
        ].join('\n');
      },
    }),

    gt_list_convoys: tool({
      description:
        'List active convoys with progress. Shows how many beads are closed vs total for each convoy. ' +
        'Use this to check on batched work or answer "how is X going?" questions.',
      args: {},
      async execute() {
        const convoys = await client.listConvoys();
        if (convoys.length === 0) {
          return 'No active convoys. All batched work has either landed or none has been created.';
        }
        return JSON.stringify(convoys, null, 2);
      },
    }),

    gt_convoy_status: tool({
      description:
        'Show detailed status of a convoy: each tracked bead with its status and assignee. ' +
        'Use this for a detailed progress report on a specific batch of work.',
      args: {
        convoy_id: tool.schema.string().describe('The UUID of the convoy to inspect'),
      },
      async execute(args) {
        const status = await client.getConvoyStatus(args.convoy_id);
        return JSON.stringify(status, null, 2);
      },
    }),

    gt_mail_send: tool({
      description:
        'Send a mail message to an agent in any rig. ' +
        'Use this for cross-rig coordination, instructions, or status requests. ' +
        'The recipient must be identified by their agent UUID and rig UUID.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig the recipient agent belongs to'),
        to_agent_id: tool.schema.string().describe('The UUID of the recipient agent'),
        subject: tool.schema.string().describe('Subject line for the mail'),
        body: tool.schema.string().describe('Body content of the mail'),
      },
      async execute(args) {
        await client.sendMail({
          rig_id: args.rig_id,
          to_agent_id: args.to_agent_id,
          subject: args.subject,
          body: args.body,
        });
        return `Mail sent to agent ${args.to_agent_id} in rig ${args.rig_id}.`;
      },
    }),
  };
}
