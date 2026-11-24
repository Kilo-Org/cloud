export type UnblockPreview = {
  unblockable: number;
  keptBlocked: number;
  stillBlacklistedBy: string | null;
};

export type UnblockResult = {
  removed: boolean;
  unblock: {
    requested: boolean;
    unblocked: number;
    keptBlocked: number;
    remaining: boolean;
    failed: boolean;
  };
};

function accountCount(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? 'account' : 'accounts'}`;
}

export function unblockPreviewMessage(preview: UnblockPreview): string {
  if (preview.stillBlacklistedBy !== null) {
    return `This domain is still covered by the "${preview.stillBlacklistedBy}" blacklist entry. Remove that entry first.`;
  }
  if (preview.unblockable === 0 && preview.keptBlocked === 0) {
    return 'No accounts are currently blocked by this domain.';
  }
  if (preview.unblockable === 0) {
    return `No accounts with a positive balance would be unblocked. ${accountCount(
      preview.keptBlocked
    )} with no remaining balance stay blocked.`;
  }
  if (preview.keptBlocked === 0) {
    return `This will unblock ${accountCount(preview.unblockable)} with a positive balance.`;
  }
  return `This will unblock ${accountCount(
    preview.unblockable
  )} with a positive balance. ${accountCount(
    preview.keptBlocked
  )} with no remaining balance stay blocked.`;
}

export function unblockResultMessage(
  domain: string,
  result: UnblockResult
): { kind: 'success' | 'warning'; message: string } {
  const { requested, unblocked, keptBlocked, remaining, failed } = result.unblock;

  if (!requested) {
    return {
      kind: 'success',
      message: result.removed
        ? `Removed ${domain}. Existing user blocks were kept.`
        : `No user blocks changed for ${domain}.`,
    };
  }
  if (failed) {
    return {
      kind: 'warning',
      message: result.removed
        ? `Removed ${domain}, but unblocking accounts failed. Run it again to finish.`
        : `Unblocking accounts for ${domain} failed. Run it again to finish.`,
    };
  }

  const lead = result.removed ? `Removed ${domain}. ` : '';
  const kept = keptBlocked > 0 ? ` ${accountCount(keptBlocked)} stay blocked.` : '';
  if (remaining) {
    return {
      kind: 'warning',
      message: `${lead}Unblocked ${accountCount(
        unblocked
      )}; more remain. Run it again to finish.${kept}`,
    };
  }
  if (unblocked > 0) {
    return {
      kind: 'success',
      message: `${lead}Unblocked ${accountCount(unblocked)}.${kept}`,
    };
  }
  return {
    kind: 'success',
    message: `${lead}No accounts with a positive balance were unblocked.${kept}`,
  };
}
