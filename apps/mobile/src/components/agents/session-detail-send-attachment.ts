import  { type ResolvedSession } from 'cloud-agent-sdk';

/**
 * Pure decision for the send path: given the active session type and
 * capability state, pick which wire shape `manager.send()` should
 * receive. Extracted from the component so the cloud-vs-remote gate
 * is unit-testable without React.
 *
 *  - `cloud` — pass the unchanged `{path, files}` S3a wire as
 *    `attachments`. Returned for cloud-agent sessions regardless of
 *    capability (S3a is a no-op for non-cloud but the existing branch
 *    stays so the wire is stable).
 *  - `remote-capable` — call sites must `await buildRemoteAttachmentParts`
 *    and pass the result as `attachmentParts`.
 *  - `none` — no attachments path applies; the call site must omit
 *    both `attachments` and `attachmentParts`. This covers non-capable
 *    remote sessions (paperclip hidden) and read-only sessions.
 *
 * `hasAttachments` is the composer's pre-computed signal: false means
 * the user did not add any files in the first place, so the decision
 * short-circuits to `none` regardless of session type.
 */
export function resolveSendAttachmentKind(
  activeSessionType: ResolvedSession['type'] | null | undefined,
  supportsAttachments: boolean,
  hasAttachments: boolean
): 'cloud' | 'remote-capable' | 'none' {
  if (!hasAttachments) {
    return 'none';
  }
  if (activeSessionType === 'cloud-agent') {
    return 'cloud';
  }
  if (activeSessionType === 'remote' && supportsAttachments) {
    return 'remote-capable';
  }
  return 'none';
}
