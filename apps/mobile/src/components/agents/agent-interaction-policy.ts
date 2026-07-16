type ActiveRequest = { requestId: string } | null | undefined;

type BlockingInteraction = 'question' | 'permission' | 'none';

export function getBlockingInteraction(input: {
  activeQuestion: ActiveRequest;
  activePermission: ActiveRequest;
}): BlockingInteraction {
  if (input.activeQuestion) {
    return 'question';
  }
  if (input.activePermission) {
    return 'permission';
  }
  return 'none';
}
