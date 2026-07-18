// Shared status helpers for PR file rows.

import { File, FileMinus, FilePlus } from 'lucide-react-native';

export function fileStatusLabel(status: string): string {
  switch (status) {
    case 'added': {
      return 'Added';
    }
    case 'removed': {
      return 'Deleted';
    }
    case 'modified': {
      return 'Modified';
    }
    case 'renamed': {
      return 'Renamed';
    }
    case 'copied': {
      return 'Copied';
    }
    case 'changed': {
      return 'Changed';
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
