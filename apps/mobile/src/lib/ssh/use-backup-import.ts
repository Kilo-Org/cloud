import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { trackSshImport } from './analytics';
import { openSshBackup, type SshBackupFailure, sshBackupFailure } from './backup-file';
import { mergeSshBackup, planSshBackupMerge, type SshBackupPlan } from './backup-merge';
import { BACKUP_COLLECTIONS } from './backup-payload';
import { SSH_HOSTS_ROUTE } from './routes';
import { sshDatabase } from './store';
import { useSshBackup } from './use-backup';
import { useSshInvalidation } from './use-ssh';

export function useSshBackupImport(dev?: string) {
  const { t } = useTranslation();
  const router = useRouter();
  const existing = useSshBackup();
  const invalidate = useSshInvalidation();
  const passphrase = useRef('');
  const armored = useRef<string | null>(null);
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [filename, setFilename] = useState<string | null>(null);
  const [plan, setPlan] = useState<SshBackupPlan | null>(null);
  const [failure, setFailure] = useState<SshBackupFailure | null>(null);
  const [busy, setBusy] = useState(false);
  let fixturePlan: SshBackupPlan | null = null;
  if (dev === 'preview' && existing.data !== undefined) {
    fixturePlan = planSshBackupMerge(existing.data, {
      ...existing.data,
      hosts: [],
      keys: [],
      knownHosts: [],
      snippets: [],
      forwards: [],
    });
  } else if (dev === 'conflicts' && existing.data !== undefined) {
    fixturePlan = planSshBackupMerge(existing.data, existing.data);
  }
  const shownPlan = plan ?? fixturePlan;
  let fixtureFailure: SshBackupFailure | null = null;
  if (dev === 'error') {
    fixtureFailure = 'wrong_passphrase';
  } else if (dev === 'invalid') {
    fixtureFailure = 'invalid_export';
  }
  const shownFailure = failure ?? fixtureFailure;
  const hasFixtureFile = fixturePlan !== null || fixtureFailure !== null;
  const shownFilename = filename ?? (hasFixtureFile ? 'kilo-ssh-2026-11-14.age' : null);
  const nothingNew =
    shownPlan !== null &&
    BACKUP_COLLECTIONS.every(collection => shownPlan.additions[collection].length === 0);

  async function pickFile() {
    setBusy(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled) {
        trackSshImport('cancelled', null);
        return;
      }
      const asset = result.assets[0];
      if (asset === undefined) {
        return;
      }
      const file = new File(asset.uri);
      try {
        armored.current = await file.text();
      } finally {
        if (file.exists) {
          file.delete();
        }
      }
      setFilename(asset.name.trim().replaceAll(/\s+/gu, ' ') || null);
      if (plan !== null) {
        passphrase.current = '';
        setHasPassphrase(false);
      }
      setPlan(null);
      setFailure(null);
    } catch {
      armored.current = null;
      setFilename(null);
      setPlan(null);
      setFailure('file');
      trackSshImport('failed', 'local_io');
    } finally {
      setBusy(false);
    }
  }

  async function preview() {
    if (armored.current === null || existing.data === undefined || busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      setPlan(
        planSshBackupMerge(await openSshBackup(armored.current, passphrase.current), existing.data)
      );
    } catch (error) {
      setFailure(sshBackupFailure(error));
      trackSshImport('failed', sshBackupFailure(error));
    } finally {
      setBusy(false);
    }
  }

  async function importBackup() {
    if (shownPlan === null || busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      mergeSshBackup(await sshDatabase(), shownPlan.incoming);
      trackSshImport('completed', null);
      await invalidate();
      toast.success(t('ssh.backup.imported'));
      router.replace(SSH_HOSTS_ROUTE);
    } catch {
      setFailure('storage');
      trackSshImport('failed', 'local_io');
    } finally {
      setBusy(false);
    }
  }

  return {
    existing,
    shownPlan,
    shownFailure,
    shownFilename,
    nothingNew,
    busy,
    hasPassphrase,
    pickFile,
    preview,
    importBackup,
    handlePassphraseChange: (value: string) => {
      passphrase.current = value;
      setHasPassphrase(value.length > 0);
    },
  };
}
