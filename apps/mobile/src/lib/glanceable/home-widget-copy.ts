import { i18n } from '@/i18n';

/** Both native renderers and the background provider use the same translated labels. */
export function getHomeWidgetCopy() {
  return {
    needsInput: i18n.t('glanceable.needsInput'),
    running: i18n.t('common.working'),
    scheduled: i18n.t('common.scheduled'),
    idle: i18n.t('common.idle'),
    waiting: i18n.t('glanceable.waiting'),
    empty: i18n.t('home.noLiveSessions'),
    signed_out: i18n.t('glanceable.signedOut'),
    privacy: i18n.t('glanceable.privacy'),
    checked: i18n.t('glanceable.checked'),
    lastKnown: i18n.t('glanceable.lastKnown'),
    awaitingUpdate: i18n.t('glanceable.awaitingUpdate'),
    nextRun: i18n.t('glanceable.nextRun'),
    agent: i18n.t('common.agent'),
    waitingForYou: i18n.t('glanceable.waitingForYou'),
    nextScheduled: i18n.t('glanceable.nextScheduled'),
    permissionRequired: i18n.t('agentChat.permissionCard.title'),
    answerNeeded: i18n.t('glanceable.answerNeeded'),
    waitingToRetry: i18n.t('glanceable.waitingToRetry'),
    approving: i18n.t('glanceable.approving'),
    couldNotApprove: i18n.t('glanceable.couldNotApprove'),
    approve: i18n.t('common.approve'),
    newAgent: i18n.t('glanceable.newAgent'),
    openAgents: i18n.t('glanceable.openAgents'),
    locale: i18n.language,
  };
}
