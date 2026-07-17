import { type FindingIconKey, type FindingTone } from '@kilocode/app-shared/security-agent';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  type LucideIcon,
  Shield,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react-native';

import { type ThemeColors } from '@/lib/hooks/use-theme-colors';

// Single source for mapping the presentation module's icon keys/tones to
// actual lucide-react-native components and theme colors — shared by
// finding-row.tsx and the finding detail panels so tone styling stays
// consistent everywhere a FindingTone is rendered.

export const FINDING_ICONS: Record<FindingIconKey, LucideIcon> = {
  loader: Loader2,
  'x-circle': XCircle,
  eye: Eye,
  'shield-alert': ShieldAlert,
  'shield-check': ShieldCheck,
  shield: Shield,
  brain: Brain,
  'check-circle': CheckCircle2,
  clock: Clock3,
  'alert-triangle': AlertTriangle,
};

export const FINDING_TONE_TEXT_CLASS: Record<FindingTone, string> = {
  success: 'text-good',
  warning: 'text-warn',
  danger: 'text-destructive',
  neutral: 'text-muted-foreground',
};

export const FINDING_TONE_TO_KV_ROW_TONE: Record<
  FindingTone,
  'default' | 'good' | 'warn' | 'danger' | 'muted'
> = {
  success: 'good',
  warning: 'warn',
  danger: 'danger',
  neutral: 'muted',
};

export function findingToneColor(colors: ThemeColors, tone: FindingTone): string {
  switch (tone) {
    case 'success': {
      return colors.good;
    }
    case 'warning': {
      return colors.warn;
    }
    case 'danger': {
      return colors.destructive;
    }
    case 'neutral': {
      return colors.mutedForeground;
    }
    default: {
      const exhaustiveCheck: never = tone;
      throw new Error(`Unhandled finding tone: ${String(exhaustiveCheck)}`);
    }
  }
}
