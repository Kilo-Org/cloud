import {
  Cpu,
  Eye,
  FileDiff,
  FilePlus,
  FileSearch,
  FolderOpen,
  Globe,
  ListTodo,
  type LucideIcon,
  Pencil,
  Plug,
  Search,
  Sparkles,
  Terminal,
} from '@/components/ui/icons';

/**
 * The exact leading icon the tool's card renders. Each tool maps to the icon
 * its card passes to `FixedPartRow`; unknown tools use the generic card's Plug.
 */
export function getToolRowIcon(tool: string): LucideIcon {
  switch (tool) {
    case 'read': {
      return Eye;
    }
    case 'edit': {
      return Pencil;
    }
    case 'write': {
      return FilePlus;
    }
    case 'bash': {
      return Terminal;
    }
    case 'glob': {
      return Search;
    }
    case 'grep': {
      return FileSearch;
    }
    case 'list': {
      return FolderOpen;
    }
    case 'patch':
    case 'apply_patch': {
      return FileDiff;
    }
    case 'todoread':
    case 'todowrite': {
      return ListTodo;
    }
    case 'websearch':
    case 'codesearch':
    case 'webfetch': {
      return Globe;
    }
    case 'task': {
      return Cpu;
    }
    case 'suggest': {
      return Sparkles;
    }
    default: {
      return Plug;
    }
  }
}
