import { afterEach, expect, it, vi } from 'vitest';

import { type SshBackupFailure } from '@/lib/ssh/backup-file';
import { type SshBackupPlan } from '@/lib/ssh/backup-merge';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { SshBackupImportScreen } from './backup-import-screen';

const state = vi.hoisted(() => ({
  failure: null as SshBackupFailure | null,
  plan: null as SshBackupPlan | null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/ssh/use-backup-import', () => ({
  useSshBackupImport: () => ({
    existing: { isPending: false, isError: false },
    shownPlan: state.plan,
    shownFailure: state.failure,
    shownFilename: 'kilo-ssh-fixture.age',
    nothingNew: state.plan !== null,
    busy: false,
    hasPassphrase: true,
    handlePassphraseChange: vi.fn(),
    pickFile: vi.fn(),
    preview: vi.fn(),
    importBackup: vi.fn(),
  }),
}));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'ScrollView' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ssh/backup-loading', () => ({ SshBackupLoading: 'SshBackupLoading' }));
vi.mock('@/components/ssh/backup-summary', () => ({
  SshBackupConflicts: 'SshBackupConflicts',
  SshBackupOutcome: 'SshBackupOutcome',
  SshBackupSummary: 'SshBackupSummary',
}));
vi.mock('@/components/ssh/ssh-storage-error', () => ({ SshStorageError: 'SshStorageError' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/form-field', () => ({ FormField: 'FormField' }));
vi.mock('@/components/ui/icons', () => ({
  Download: 'Download',
  FileText: 'FileText',
  Lock: 'Lock',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let mounted: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => {
    mounted?.unmount();
  });
  mounted = null;
  state.failure = null;
  state.plan = null;
});

function renderScreen() {
  act(() => {
    mounted = TestRenderer.create(<SshBackupImportScreen />);
  });
  if (mounted === null) {
    throw new Error('Screen did not mount');
  }
  return mounted;
}

it('uses the standard visible form field and places a wrong-passphrase error on that field', () => {
  state.failure = 'wrong_passphrase';
  const renderer = renderScreen();
  const field = renderer.root.find(node => (node.type as string) === 'FormField');
  expect(field.props.label).toBe('ssh.session.passphrase');
  expect(field.props.error).toBe('ssh.backup.wrongPassphrase');
  expect(field.props.reserveErrorMessages).toEqual(['ssh.backup.wrongPassphrase']);
  expect(field.props.secureTextEntry).toBe(true);
});

it('puts an invalid-file error on the file selection status and prevents unlocking that file again', () => {
  state.failure = 'invalid_export';
  const renderer = renderScreen();
  const status = renderer.root.findAll(node => (node.type as string) === 'AccessibleStatus');
  expect(status[0]?.props.message).toBe('ssh.backup.invalidExport');
  const field = renderer.root.find(node => (node.type as string) === 'FormField');
  expect(field.props.error).toBeUndefined();
  const buttons = renderer.root.findAll(node => (node.type as string) === 'Button');
  expect(buttons[1]?.props.disabled).toBe(true);
});

it('leads with the import outcome and keeps the nothing-new outcome and action before conflicts', () => {
  const backup = {
    format: 'kilo-ssh',
    version: 1,
    hosts: [],
    keys: [],
    knownHosts: [],
    snippets: [],
    forwards: [],
  } as const;
  state.plan = {
    incoming: { ...backup, hosts: [], keys: [], knownHosts: [], snippets: [], forwards: [] },
    additions: { ...backup, hosts: [], keys: [], knownHosts: [], snippets: [], forwards: [] },
    conflicts: [],
  };
  const renderer = renderScreen();
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered.indexOf('SshBackupOutcome')).toBeLessThan(
    rendered.indexOf('ssh.backup.nothingNew')
  );
  expect(rendered.indexOf('ssh.backup.nothingNew')).toBeLessThan(
    rendered.indexOf('SshBackupConflicts')
  );
  expect(rendered.indexOf('ssh.backup.apply')).toBeLessThan(rendered.indexOf('SshBackupConflicts'));
});
