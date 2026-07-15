export interface WorkerDisplayNameFields {
  display_name: string;
  display_alias: string | null;
}

/** Returns the human-facing worker name without changing its stable executor identity. */
export function effectiveWorkerDisplayName(worker: WorkerDisplayNameFields): string {
  return worker.display_alias ?? worker.display_name;
}

/** Converts stored worker name fields into the public alias-aware API contract. */
export function publicWorkerDisplayName(worker: WorkerDisplayNameFields) {
  return {
    display_name: effectiveWorkerDisplayName(worker),
    display_alias: worker.display_alias,
    reported_display_name: worker.display_name
  };
}
