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
        'Optionally filter by status (open, in_progress, closed, failed) or type (issue, message, escalation, merge_request). ' +
        'Use this to check what work exists in a rig, what is in progress, and what has been completed.',
      args: {
        rig_id: tool.schema.string().describe('The UUID of the rig to list beads from'),
        status: tool.schema
          .enum(['open', 'in_progress', 'closed', 'failed'])
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
