// Catalog keys for the stable dismissal reason codes the API stores on a
// finding (`ignored_reason`) and on its audit events (`reason_code`). The
// server can record a code before this app ships copy for it, so each reader
// decides what an unknown code shows.

// Standalone labels: a form field or a labelled line, e.g. "Reason: …".
export const DISMISSAL_REASON_LABEL_KEYS = {
  fix_started: 'securityAgent.dismiss.reasonFixStarted',
  no_bandwidth: 'securityAgent.dismiss.reasonNoBandwidth',
  tolerable_risk: 'securityAgent.dismiss.reasonTolerableRisk',
  inaccurate: 'securityAgent.dismiss.reasonInaccurate',
  not_used: 'securityAgent.dismiss.reasonNotUsed',
} satisfies Record<string, string>;
