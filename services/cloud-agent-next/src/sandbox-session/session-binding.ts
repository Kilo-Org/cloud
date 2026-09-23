/**
 * The single session-binding derivation. `terminal_attached_session` stays the
 * only binding owner; this module projects that record into the aggregate-level
 * `binding`, parameterised by the messages being encoded. It is shared by the
 * stopped seam and the Durable Object so the projection is never re-derived.
 *
 * A bound handle is projected from the authoritative allocation incarnation. A
 * legacy, incarnation-less attachment is `unresolved` while accepted work
 * survives, because the real loss proof carries the allocation incarnation and a
 * fabricated one would reject it; with no accepted work it is `unbound`.
 */
import type { Binding, SessionMessage } from '../sandbox-state/model/session.js';

/**
 * The binding-relevant projection of the attachment record. `allocationIncarnation`
 * is absent on pre-C3b records, which are resolved before the seam runs;
 * `undefined` models an already-cleared (duplicate) attachment.
 */
export type StoppedAttachment = {
  allocationIncarnation?: string;
  wrapperInstanceId: string;
};

export function bindingForAttachment(
  attachment: StoppedAttachment | undefined,
  messages: readonly SessionMessage[]
): Binding {
  if (attachment?.allocationIncarnation !== undefined) {
    return {
      kind: 'bound',
      handle: {
        incarnation: attachment.allocationIncarnation,
        wrapper: attachment.wrapperInstanceId,
        epoch: 0,
      },
    };
  }
  return messages.some(message => message.state.kind === 'accepted')
    ? { kind: 'unresolved' }
    : { kind: 'unbound' };
}
