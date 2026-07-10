import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { SecurityFinding } from '@kilocode/db/schema';
import {
  getSecurityAnalysisPresentation,
  getSecurityDeadlinePresentation,
  getSecurityFindingAnalysisState,
  type FindingIconKey,
  type FindingTone as SharedFindingTone,
  type SecurityFindingAnalysisState,
} from '@kilocode/app-shared/security-agent';

export type FindingTone = 'success' | 'warning' | 'destructive' | 'neutral';

export type FindingStatusPresentation = {
  label: string;
  tone: FindingTone;
  icon: LucideIcon;
  spinning?: boolean;
  tooltip?: string | null;
};

export type FindingDeadlinePresentation = FindingStatusPresentation & {
  detail: string;
};

export type FindingAnalysisState = SecurityFindingAnalysisState;

const gridWithSla = 'xl:grid-cols-[minmax(0,1fr)_9rem_8.5rem_minmax(9rem,auto)_2.25rem] xl:gap-x-3';
const gridWithoutSla = 'xl:grid-cols-[minmax(0,1fr)_9rem_minmax(9rem,auto)_2.25rem] xl:gap-x-3';

export function getFindingListGridClass(showSla: boolean) {
  return showSla ? gridWithSla : gridWithoutSla;
}

// Icon KEYS from @kilocode/app-shared, not React elements — mapped here to
// web's lucide-react components so the shared module stays UI-framework-free.
const iconByKey: Record<FindingIconKey, LucideIcon> = {
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

export function toWebTone(tone: SharedFindingTone): FindingTone {
  return tone === 'danger' ? 'destructive' : tone;
}

export function getFindingAnalysisState(
  analysisStatus: string | null,
  analysis: SecurityFinding['analysis']
): FindingAnalysisState {
  return getSecurityFindingAnalysisState(analysisStatus, analysis);
}

export function getAnalysisPresentation(finding: SecurityFinding): FindingStatusPresentation {
  const presentation = getSecurityAnalysisPresentation(finding);
  return {
    ...presentation,
    icon: iconByKey[presentation.icon],
    tone: toWebTone(presentation.tone),
  };
}

export function getDeadlinePresentation(
  finding: SecurityFinding,
  now = new Date()
): FindingDeadlinePresentation {
  const presentation = getSecurityDeadlinePresentation(finding, now);
  return {
    ...presentation,
    icon: iconByKey[presentation.icon],
    tone: toWebTone(presentation.tone),
  };
}
