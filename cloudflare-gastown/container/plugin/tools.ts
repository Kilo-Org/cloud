import { tool } from '@kilocode/plugin';
import type { GastownClient } from './client';

function parseJsonArg(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid JSON in "${label}"`);
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = parseJsonArg(value, label);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `"${label}" must be a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`
    );
  }
  return parsed as Record<string, unknown>;
}

export function createTools(client: GastownClient) {
  return {
    gt_prime: tool({
      description:
        'Get full role context: your identity, hooked work (the bead you are working on), ' +
        'pending undelivered mail, and all open beads in the rig. ' +
        'Call this at the start of a session or whenever you need to re-orient.',
      args: {},
      async execute() {
        const ctx = await client.prime();
        return JSON.stringify(ctx, null, 2);
      },
    }),

    gt_bead_status: tool({
      description: 'Read the current status and full details of a bead by its ID.',
      args: {
        bead_id: tool.schema.string().describe('The UUID of the bead to inspect'),
      },
      async execute(args) {
        const bead = await client.getBead(args.bead_id);
        return JSON.stringify(bead, null, 2);
      },
    }),

    gt_bead_close: tool({
      description:
        'Close a bead, marking it as completed. Use this when you have finished the work described by the bead.',
      args: {
        bead_id: tool.schema.string().describe('The UUID of the bead to close'),
      },
      async execute(args) {
        const bead = await client.closeBead(args.bead_id);
        return JSON.stringify(bead, null, 2);
      },
    }),

    gt_done: tool({
      description:
        'Signal that your work is complete. This pushes your branch to the review queue ' +
        'and unhooks you from your current bead. You must have pushed your branch before calling this.',
      args: {
        branch: tool.schema.string().describe('The git branch name containing your work'),
        pr_url: tool.schema
          .string()
          .describe('URL of the pull request, if already created')
          .optional(),
        summary: tool.schema.string().describe('Brief summary of changes made').optional(),
      },
      async execute(args) {
        await client.done({
          branch: args.branch,
          pr_url: args.pr_url,
          summary: args.summary,
        });
        return 'Done signal sent. You have been unhooked and set to idle.';
      },
    }),

    gt_mail_send: tool({
      description:
        'Send a typed message to another agent in the rig. ' +
        'Use this for coordination, asking questions, or sending status updates.',
      args: {
        to_agent_id: tool.schema.string().describe('The UUID of the recipient agent'),
        subject: tool.schema.string().describe('Subject line for the mail'),
        body: tool.schema.string().describe('Body content of the mail'),
      },
      async execute(args) {
        await client.sendMail({
          to_agent_id: args.to_agent_id,
          subject: args.subject,
          body: args.body,
        });
        return `Mail sent to agent ${args.to_agent_id}.`;
      },
    }),

    gt_mail_check: tool({
      description:
        'Read and acknowledge all pending (undelivered) mail addressed to you. ' +
        'Returns an array of mail messages. Once read, they are marked as delivered.',
      args: {},
      async execute() {
        const mail = await client.checkMail();
        if (mail.length === 0) {
          return 'No pending mail.';
        }
        return JSON.stringify(mail, null, 2);
      },
    }),

    gt_escalate: tool({
      description:
        'Escalate an issue that you cannot resolve on your own. ' +
        'Creates an escalation bead that will be routed to a supervisor or the mayor.',
      args: {
        title: tool.schema.string().describe('Short title describing the escalation'),
        body: tool.schema.string().describe('Detailed description of the issue').optional(),
        priority: tool.schema
          .enum(['low', 'medium', 'high', 'critical'])
          .describe('Severity level (defaults to medium)')
          .optional(),
        metadata: tool.schema
          .string()
          .describe('JSON-encoded metadata object for additional context')
          .optional(),
      },
      async execute(args) {
        const metadata = args.metadata ? parseJsonObject(args.metadata, 'metadata') : undefined;
        const bead = await client.createEscalation({
          title: args.title,
          body: args.body,
          priority: args.priority,
          metadata,
        });
        return `Escalation created: ${bead.id} (priority: ${bead.priority})`;
      },
    }),

    gt_checkpoint: tool({
      description:
        'Write crash-recovery data. Store any state you would need to resume work ' +
        'if your session is interrupted. The data is stored as JSON on your agent record.',
      args: {
        data: tool.schema.string().describe('JSON-encoded checkpoint data to persist'),
      },
      async execute(args) {
        const parsed = parseJsonArg(args.data, 'data');
        await client.writeCheckpoint(parsed);
        return 'Checkpoint saved.';
      },
    }),

    gt_mol_current: tool({
      description:
        'Get the current molecule step for your hooked bead. Returns the step title, ' +
        'instructions, step number (N of M), and molecule status. ' +
        'Returns null if no molecule is attached to your current bead.',
      args: {},
      async execute() {
        const step = await client.getMoleculeCurrentStep();
        if (!step) return 'No molecule attached to your current bead.';
        return JSON.stringify(step, null, 2);
      },
    }),

    gt_mol_advance: tool({
      description:
        'Complete the current molecule step and advance to the next one. ' +
        'Provide a summary of what you accomplished in this step. ' +
        'If this is the final step, the molecule is marked as completed.',
      args: {
        summary: tool.schema
          .string()
          .describe('Brief summary of what you accomplished in this step'),
      },
      async execute(args) {
        const result = await client.advanceMoleculeStep(args.summary);
        if (result.completed) {
          return `Molecule completed! All ${result.totalSteps} steps are done.`;
        }
        return `Advanced to step ${result.currentStep + 1} of ${result.totalSteps}.`;
      },
    }),
  };
}
