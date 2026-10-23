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

// Mid-sentence forms, for "Dismissed because {{reason}}." in the finding
// details panel, where the phrase continues the sentence.
export const DISMISSAL_REASON_PHRASE_KEYS = {
  fix_started: 'securityAgent.findingDetails.reasonFixStarted',
  no_bandwidth: 'securityAgent.findingDetails.reasonNoBandwidth',
  tolerable_risk: 'securityAgent.findingDetails.reasonTolerableRisk',
  inaccurate: 'securityAgent.findingDetails.reasonInaccurate',
  not_used: 'securityAgent.findingDetails.reasonNotUsed',
} satisfies Record<string, string>;
