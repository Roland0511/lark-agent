export interface AdminUser { openId: string; displayName: string | null; role: "owner"; csrfToken: string; agentDisplayName: string }

const adminMarker = "/admin";
const markerIndex = window.location.pathname.indexOf(adminMarker);
export const publicBasePath = markerIndex > 0 ? window.location.pathname.slice(0, markerIndex).replace(/\/$/, "") : "";
export const adminBasePath = `${publicBasePath}${adminMarker}`;

export function publicPath(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${publicBasePath}${normalized}`;
}

export function adminPath(path = ""): string {
  if (!path) return adminBasePath;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${adminBasePath}${normalized}`;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}, user?: AdminUser): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set("content-type", "application/json");
  if (user && init.method && init.method !== "GET") headers.set("x-csrf-token", user.csrfToken);
  const response = await fetch(publicPath(path), { ...init, headers, credentials: "same-origin" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: { message?: string; code?: string } };
    throw new ApiError(response.status, body.error?.message ?? `请求失败（${response.status}）`, body.error?.code);
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export function commandBody(command: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ command, ...extra });
}

export function relativeTime(value: string | null): string {
  if (!value) return "—";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}
