import { type SshHost, hostInputSchema, type SshHostInput } from './hosts';

export type SshAuthMethod = 'password' | 'key' | 'keyboard_interactive';

export type HostFormField =
  | 'label'
  | 'hostname'
  | 'port'
  | 'username'
  | 'password'
  | 'keyId'
  | 'jumpHostId'
  | 'tmuxSessionName';

/** What a field says when its value is refused. */
export type HostFormErrorKind = 'required' | 'invalidPort';

export type HostFormIssue = Readonly<{ field: HostFormField; kind: HostFormErrorKind }>;

const FORM_FIELDS: readonly HostFormField[] = [
  'label',
  'hostname',
  'port',
  'username',
  'password',
  'keyId',
  'jumpHostId',
  'tmuxSessionName',
];

export type HostFormValues = Readonly<{
  label: string;
  hostname: string;
  portText: string;
  username: string;
  authMethod: SshAuthMethod;
  password: string;
  savePassword: boolean;
  keyId: string | null;
  jumpHostId: string | null;
  tmuxAttach: boolean;
  tmuxSessionName: string;
}>;

/**
 * The host record the form's values describe. The password is kept only when
 * password authentication is chosen and the person asked to save it, and the
 * key only when key authentication is chosen, so switching the method cannot
 * leave a secret behind on a host that no longer uses it.
 */
export function toHostInput(values: HostFormValues): SshHostInput {
  const portText = values.portText.trim();
  return {
    label: values.label.trim(),
    hostname: values.hostname.trim(),
    port: /^\d+$/.test(portText) ? Number(portText) : Number.NaN,
    username: values.username.trim(),
    authMethod: values.authMethod,
    password: values.authMethod === 'password' && values.savePassword ? values.password : null,
    keyId: values.authMethod === 'key' ? values.keyId : null,
    jumpHostId: values.jumpHostId,
    tmuxAttach: values.tmuxAttach,
    tmuxSessionName: values.tmuxAttach ? values.tmuxSessionName.trim() || null : null,
  };
}

/** The form's values for a stored host, ready to be edited. */
export function hostFormValuesOf(host: SshHost | null): HostFormValues {
  return {
    label: host?.label ?? '',
    hostname: host?.hostname ?? '',
    portText: String(host?.port ?? 22),
    username: host?.username ?? '',
    authMethod: host?.authMethod ?? 'password',
    password: '',
    savePassword: host?.password != null,
    keyId: host?.keyId ?? null,
    jumpHostId: host?.jumpHostId ?? null,
    tmuxAttach: host?.tmuxAttach ?? false,
    tmuxSessionName: host?.tmuxSessionName ?? '',
  };
}

/** Which field each refused value belongs to, from the store's own schema. */
export function validateHostInput(input: SshHostInput): HostFormIssue[] {
  const parsed = hostInputSchema.safeParse(input);
  if (parsed.success) {
    return [];
  }
  const issues: HostFormIssue[] = [];
  for (const field of FORM_FIELDS) {
    const refused = parsed.error.issues.some(issue => issue.path[0] === field);
    if (refused) {
      issues.push({ field, kind: field === 'port' ? 'invalidPort' : 'required' });
    }
  }
  return issues;
}

export function hostFormIssue(
  issues: readonly HostFormIssue[],
  field: HostFormField
): HostFormErrorKind | undefined {
  return issues.find(issue => issue.field === field)?.kind;
}
