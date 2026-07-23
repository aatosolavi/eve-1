/** Attempts every cleanup operation and rethrows the first failure afterward. */
export async function disposeAll(disposers: readonly (() => Promise<void>)[]): Promise<void> {
  let firstFailure: unknown;
  let failed = false;

  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstFailure = error;
      }
    }
  }

  if (failed) throw firstFailure;
}
