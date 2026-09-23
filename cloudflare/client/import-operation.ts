/** One owner for file reads, previews, saved receipts and import requests. */
export function createImportOperationLock(onChange: (busy: boolean) => void) {
  let active: { cancel?: () => void } | null = null;
  return {
    get busy() { return active !== null; },
    begin(cancel?: () => void) {
      if (active) return null;
      const operation = { cancel };
      active = operation;
      onChange(true);
      return operation;
    },
    current(operation: object) { return active === operation; },
    finish(operation: object) {
      if (active !== operation) return;
      active = null;
      onChange(false);
    },
    cancelRead() {
      if (!active?.cancel) return;
      const cancel = active.cancel;
      active = null;
      cancel();
      onChange(false);
    },
  };
}
