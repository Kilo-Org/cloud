// Shared status helpers for PR file rows.

import { File, FileMinus, FilePlus } from '@/components/ui/icons';
import { i18n } from '@/i18n';

export function fileStatusLabel(status: string): string {
  switch (status) {
    case 'added': {
      return i18n.t('prReview.fileStatus.added');
    }
    case 'removed': {
      return i18n.t('prReview.fileStatus.deleted');
    }
    case 'modified': {
      return i18n.t('prReview.fileStatus.modified');
    }
    case 'renamed': {
      return i18n.t('prReview.fileStatus.renamed');
    }
    case 'copied': {
      return i18n.t('prReview.fileStatus.copied');
    }
    case 'changed': {
      return i18n.t('prReview.fileStatus.changed');
    }
    default: {
      return status;
    }
  }
}

export function fileStatusIcon(status: string) {
  switch (status) {
    case 'added': {
      return FilePlus;
    }
    case 'removed': {
      return FileMinus;
    }
    default: {
      return File;
    }
  }
}
