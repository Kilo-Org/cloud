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
  return Object.fromEntries(Object.entries(parsed as object));
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

    gt_request_changes: tool({
      description:
        'Request changes on the code you are reviewing. This creates a rework task ' +
        'for a polecat to address your feedback. After calling this, call gt_done to ' +
        'release your session. The polecat will push fixes to the same branch, and ' +
        'you will be re-dispatched to re-review once the rework is complete. ' +
        'Only available to refinery agents.',
      args: {
        feedback: tool.schema
          .string()
          .describe(
            'Detailed description of what needs to change. Be specific: ' +
              'reference file names, function names, and the exact issues found.'
          ),
        files: tool.schema
          .array(tool.schema.string())
          .describe('Optional list of specific file paths that need changes')
          .optional(),
      },
      async execute(args) {
        const result = await client.requestChanges({
          feedback: args.feedback,
          files: args.files,
        });
        return (
          `Rework request created (bead ${result.rework_bead_id}). ` +
          'A polecat will be assigned to address your feedback. ' +
          'Call gt_done now to release your session. You will be re-dispatched to re-review once the rework is complete.'
        );
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
        return `Escalation created: ${bead.bead_id} (priority: ${bead.priority})`;
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

    gt_triage_resolve: tool({
      description:
        'Resolve a triage request with your chosen action. The TownDO will execute ' +
        'the action (restart agent, close bead, escalate, etc.) and close the triage request.',
      args: {
        triage_request_bead_id: tool.schema
          .string()
          .describe('The UUID of the triage_request bead to resolve'),
        action: tool.schema
          .string()
          .describe(
            'The chosen action from the available options (e.g. RESTART, ESCALATE_TO_MAYOR, CLOSE_BEAD)'
          ),
        resolution_notes: tool.schema
          .string()
          .describe('Brief explanation of your reasoning for choosing this action'),
      },
      async execute(args) {
        await client.resolveTriage({
          triage_request_bead_id: args.triage_request_bead_id,
          action: args.action,
          resolution_notes: args.resolution_notes,
        });
        return `Triage request ${args.triage_request_bead_id} resolved with action: ${args.action}`;
      },
    }),

    gt_status: tool({
      description:
        'Emit a plain-language status update visible on the dashboard. ' +
        'Call this when starting a new phase of work (e.g. "Installing dependencies", ' +
        '"Writing tests", "Fixing lint errors"). Write it as a brief sentence for a teammate, ' +
        'not a log line. Do NOT call this on every tool use â only at meaningful phase transitions.',
      args: {
        message: tool.schema
          .string()
          .describe('A 1-2 sentence plain-language description of what you are currently doing.'),
      },
      async execute(args) {
        await client.updateAgentStatusMessage(args.message);
        return 'Status updated.';
      },
    }),

    gt_nudge: tool({
      description:
        'Send a real-time nudge to another agent. Unlike gt_mail_send (which queues a formal ' +
        "persistent message), gt_nudge delivers immediately at the agent's next idle moment. " +
        'Use this for time-sensitive coordination: wake up an agent, request a status check, ' +
        'or notify of a blocking issue.',
      args: {
        target_agent_id: tool.schema.string().describe('UUID of the agent to nudge'),
        message: tool.schema.string().describe('The message to deliver'),
        mode: tool.schema
          .enum(['wait-idle', 'immediate', 'queue'])
          .describe(
            'Delivery mode: wait-idle (default) delivers at next idle moment; ' +
              'immediate injects mid-task; queue delivers with TTL'
          )
          .optional(),
      },
      async execute(args) {
        const result = await client.nudge({
          target_agent_id: args.target_agent_id,
          message: args.message,
          mode: args.mode ?? 'wait-idle',
        });
        return `Nudge queued: ${result.nudge_id} (mode: ${args.mode ?? 'wait-idle'})`;
      },
    }),
  };
}
