export type BestEffortPostCommitTask = {
  run: () => Promise<void>;
  reportError: (error: unknown) => void;
};

export async function runBestEffortPostCommitTasks(
  tasks: readonly BestEffortPostCommitTask[]
): Promise<void> {
  await Promise.all(
    tasks.map(async task => {
      try {
        await task.run();
      } catch (error) {
        task.reportError(error);
      }
    })
  );
}
