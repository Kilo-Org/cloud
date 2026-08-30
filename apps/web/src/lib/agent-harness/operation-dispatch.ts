import 'server-only';
import { ToolOutcomeSchema } from '@kilocode/agent-harness/contracts';
import { toolDefinitions } from '@kilocode/agent-harness/tools';
import { OrganizationRoleSchema } from '@/lib/organizations/organization-types';
import {
  authorizeHarnessCapability,
  harnessInputDigest,
  mintHarnessCapability,
} from './authorization';
import { executeHarnessInvitation, reconcileHarnessInvitation } from './invitation';
import { executeHarnessRead } from './kilo-reads';
import { executeHarnessCloudAgent, reconcileHarnessCloudAgent } from './cloud-agent';
import {
  HarnessOperationSchema,
  bounded,
  harnessOperationFailure,
  harnessOperationScope,
  invalid,
  messages,
  safeError,
} from './operation-contract';

export async function executeHarnessDispatch(raw: unknown, token: string, signal: AbortSignal) {
  let uncertain = false;
  try {
    const parsed = HarnessOperationSchema.safeParse(raw);
    if (!parsed.success) return invalid();
    const input = parsed.data;
    if (input.type !== 'execute' && input.type !== 'reconcile') return invalid();
    const scope = harnessOperationScope(bounded(input));
    const { grant } = await authorizeHarnessCapability(token, scope);
    const { request, dispatchStartedAt } = input;
    const definition = toolDefinitions.find(tool => tool.name === request.name);
    if (!definition || definition.group !== 'kilo' || definition.executorKind !== 'backend')
      return invalid();
    if (
      request.name === 'kilo.invite' &&
      !OrganizationRoleSchema.safeParse(request.arguments.role).success
    )
      return invalid();
    const cloud = request.name.startsWith('kilo.sessions.');
    if (
      input.type === 'reconcile' &&
      request.name !== 'kilo.invite' &&
      !(cloud && definition.effect === 'side_effect')
    )
      invalid();
    if (
      input.type === 'execute' &&
      cloud &&
      definition.effect === 'side_effect' &&
      dispatchStartedAt === undefined
    )
      invalid();
    // Bind the whole envelope above; mint only the adapter's existing, narrower input contract.
    const capability = await mintHarnessCapability(grant.id, {
      ...scope,
      operation: request.name,
      definitionVersion: definition.version,
      inputDigest: harnessInputDigest(
        cloud && definition.effect === 'side_effect' && dispatchStartedAt !== undefined
          ? { arguments: request.arguments, dispatchStartedAt }
          : request.arguments
      ),
    });
    if (signal.aborted) {
      // Cancelling a status check does not cancel the original mutation.
      return input.type === 'reconcile'
        ? harnessOperationFailure(undefined, true)
        : { result: { status: 'cancelled' as const } };
    }
    const invocation = { conversationId: input.conversationId, operationId: input.operationId };
    uncertain = input.type === 'reconcile' || definition.effect !== 'read';
    const output =
      request.name === 'kilo.invite'
        ? await (input.type === 'execute' ? executeHarnessInvitation : reconcileHarnessInvitation)(
            capability,
            { ...invocation, arguments: request.arguments }
          )
        : cloud
          ? await (
              input.type === 'execute' ? executeHarnessCloudAgent : reconcileHarnessCloudAgent
            )(capability, {
              ...invocation,
              name: request.name,
              arguments: request.arguments,
              // Old attempts lack this field. Keep explicit absence until those records are gone.
              dispatchStartedAt,
            })
          : await executeHarnessRead(capability, { ...invocation, ...request });
    const outcome = ToolOutcomeSchema.parse(
      cloud
        ? output
        : request.name === 'kilo.invite' && input.type === 'reconcile' && output === null
          ? { status: 'outcome_unknown', reason: messages.outcome_unknown }
          : { status: 'succeeded', output }
    );
    if (outcome.status === 'succeeded')
      return {
        result: bounded({ ...outcome, output: definition.outputSchema.parse(outcome.output) }),
      };
    if (outcome.status === 'failed')
      return { result: { ...outcome, error: safeError(outcome.error) } };
    return {
      result:
        outcome.status === 'outcome_unknown'
          ? {
              status: outcome.status,
              reason: messages.outcome_unknown,
              providerReference: input.operationId,
            }
          : outcome,
    };
  } catch (error) {
    return harnessOperationFailure(error, uncertain);
  }
}
