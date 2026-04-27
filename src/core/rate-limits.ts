import type { RateLimitSnapshot, RateLimitWindow } from "../types/app-server";

export interface RateLimitResponse {
  rateLimits: RateLimitSnapshot | null;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot | undefined> | null;
}

export interface RateLimitWindowView {
  label: string;
  remainingPercent: number;
  usedPercent: number;
  resetLabel: string;
}

export interface RateLimitUsageView {
  summary: string;
  title: string;
  primary: RateLimitWindowView | null;
  secondary: RateLimitWindowView | null;
}

export function normalizeRateLimitResponse(value: any): RateLimitResponse {
  const byLimitId = normalizeRateLimitsByLimitId(value?.rateLimitsByLimitId);
  const fallback = normalizeRateLimitSnapshot(value?.rateLimits) ?? normalizeRateLimitSnapshotLike(value);
  const codexEntries = Object.entries(byLimitId ?? {})
    .filter(([key]) => key.startsWith("codex"))
    .map(([, item]) => item);
  const candidates = [byLimitId?.codex, ...codexEntries, fallback, ...Object.values(byLimitId ?? {})].filter(
    (item): item is RateLimitSnapshot => Boolean(item)
  );
  const preferred = candidates.find(hasUsableRateLimitSnapshot) ?? candidates[0] ?? null;

  return {
    rateLimits: preferred,
    rateLimitsByLimitId: byLimitId
  };
}

export function normalizeRateLimitSnapshot(value: any): RateLimitSnapshot | null {
  if (!value || typeof value !== "object") return null;
  return {
    limitId: typeof value.limitId === "string" ? value.limitId : null,
    limitName: typeof value.limitName === "string" ? value.limitName : null,
    primary: normalizeRateLimitWindow(value.primary),
    secondary: normalizeRateLimitWindow(value.secondary),
    credits: value.credits && typeof value.credits === "object" ? value.credits : null,
    planType: typeof value.planType === "string" ? value.planType : null,
    rateLimitReachedType: typeof value.rateLimitReachedType === "string" ? value.rateLimitReachedType : null
  };
}

export function normalizeRateLimitsByLimitId(value: any): Record<string, RateLimitSnapshot | undefined> | null {
  if (!value || typeof value !== "object") return null;
  const result: Record<string, RateLimitSnapshot | undefined> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = normalizeRateLimitSnapshot(item) ?? undefined;
  }
  return result;
}

export function formatRateLimitUsage(rateLimits: RateLimitSnapshot | null): RateLimitUsageView {
  const primary = formatRateLimitWindow(rateLimits?.primary ?? null, "5小时");
  const secondary = formatRateLimitWindow(rateLimits?.secondary ?? null, "1周");
  const summary = primary ? `用量 ${primary.remainingPercent}%` : secondary ? `用量 ${secondary.remainingPercent}%` : "用量 --";
  const parts = [primary, secondary]
    .filter((item): item is RateLimitWindowView => Boolean(item))
    .map((item) => `${item.label} ${item.remainingPercent}% · ${item.resetLabel}`);
  return {
    summary,
    title: parts.length ? `剩余额度：${parts.join(" / ")}` : "Codex 用量暂不可用",
    primary,
    secondary
  };
}

function normalizeRateLimitWindow(value: any): RateLimitWindow | null {
  if (!value || typeof value !== "object" || typeof value.usedPercent !== "number") return null;
  return {
    usedPercent: value.usedPercent,
    windowDurationMins: typeof value.windowDurationMins === "number" ? value.windowDurationMins : null,
    resetsAt: typeof value.resetsAt === "number" ? value.resetsAt : null
  };
}

function normalizeRateLimitSnapshotLike(value: any): RateLimitSnapshot | null {
  if (!value || typeof value !== "object") return null;
  if (!("primary" in value) && !("secondary" in value) && !("limitId" in value) && !("limitName" in value)) return null;
  return normalizeRateLimitSnapshot(value);
}

function hasUsableRateLimitSnapshot(value: RateLimitSnapshot): boolean {
  return typeof value.primary?.usedPercent === "number" || typeof value.secondary?.usedPercent === "number";
}

function formatRateLimitWindow(value: RateLimitWindow | null, fallbackLabel: string): RateLimitWindowView | null {
  if (!value || typeof value.usedPercent !== "number") return null;
  const usedPercent = clampPercent(Math.round(value.usedPercent));
  return {
    label: formatWindowDuration(value.windowDurationMins) ?? fallbackLabel,
    remainingPercent: clampPercent(100 - usedPercent),
    usedPercent,
    resetLabel: formatResetLabel(value.resetsAt)
  };
}

function formatWindowDuration(minutes: number | null | undefined): string | null {
  if (!minutes) return null;
  if (minutes === 300) return "5小时";
  if (minutes === 10080) return "1周";
  if (minutes < 60) return `${minutes}分钟`;
  if (minutes % 1440 === 0) return `${minutes / 1440}天`;
  if (minutes % 60 === 0) return `${minutes / 60}小时`;
  return `${minutes}分钟`;
}

function formatResetLabel(epochSeconds: number | null | undefined): string {
  if (!epochSeconds) return "--";
  const date = new Date(epochSeconds * 1000);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
