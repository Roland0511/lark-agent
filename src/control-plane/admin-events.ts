import { EventEmitter } from "node:events";

export interface AdminChangeEvent {
  type: "task" | "worker" | "bot" | "chat_context" | "skill" | "approval" | "outbox" | "incident" | "runtime" | "settings";
  id?: string;
  at: string;
}

export class AdminEventBus extends EventEmitter {
  publish(type: AdminChangeEvent["type"], id?: string): void {
    this.emit("change", { type, ...(id ? { id } : {}), at: new Date().toISOString() } satisfies AdminChangeEvent);
  }
}
