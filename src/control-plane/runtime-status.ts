export interface ConsumerRuntimeStatus {
  enabled: boolean;
  required: boolean;
  state: "disabled" | "starting" | "ready" | "error";
  ready: boolean;
  lastReadyAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  restartCount: number;
}

export class RuntimeStatus {
  readonly startedAt = new Date();
  private readonly consumers = new Map<string, ConsumerRuntimeStatus>();

  configure(eventKey: string, enabled: boolean, required: boolean): void {
    const current = this.consumers.get(eventKey);
    this.consumers.set(eventKey, {
      enabled,
      required,
      state: enabled ? (current?.ready ? "ready" : current?.state === "error" ? "error" : "starting") : "disabled",
      ready: enabled && (current?.ready ?? false),
      lastReadyAt: current?.lastReadyAt ?? null,
      lastErrorAt: current?.lastErrorAt ?? null,
      lastError: enabled ? (current?.lastError ?? null) : null,
      restartCount: current?.restartCount ?? 0
    });
  }

  ready(eventKey: string): void {
    const current = this.current(eventKey);
    this.consumers.set(eventKey, { ...current, enabled: true, state: "ready", ready: true, lastReadyAt: new Date().toISOString(), lastError: null });
  }

  error(eventKey: string, error: Error): void {
    const current = this.current(eventKey);
    this.consumers.set(eventKey, {
      ...current,
      state: "error",
      ready: false,
      lastErrorAt: new Date().toISOString(),
      lastError: error.message.slice(0, 500),
      restartCount: current.restartCount + 1
    });
  }

  isReady(eventKey: string): boolean {
    return this.current(eventKey).ready;
  }

  requiredReady(): boolean {
    return [...this.consumers.values()].every((status) => !status.required || !status.enabled || status.ready);
  }

  snapshot(keys?: string[]): Record<string, ConsumerRuntimeStatus> {
    const selected = keys ?? [...this.consumers.keys()];
    return Object.fromEntries(selected.map((key) => [key, this.current(key)]));
  }

  private current(eventKey: string): ConsumerRuntimeStatus {
    return this.consumers.get(eventKey) ?? {
      enabled: false,
      required: false,
      state: "disabled",
      ready: false,
      lastReadyAt: null,
      lastErrorAt: null,
      lastError: null,
      restartCount: 0
    };
  }
}
