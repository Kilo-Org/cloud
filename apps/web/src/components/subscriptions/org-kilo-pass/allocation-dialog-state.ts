export function isPassAssignmentSaveDisabled(input: {
  reductionRequired: number;
  stalePlanMessage?: string;
  isBusy: boolean;
}) {
  return input.reductionRequired > 0 || Boolean(input.stalePlanMessage) || input.isBusy;
}
