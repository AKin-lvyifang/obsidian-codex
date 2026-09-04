export const DEFAULT_JOURNAL_DIRECTORY = "journal";

export function normalizeJournalDirectory(value: unknown): string {
  return normalizedJournalDirectoryOrNull(value) ?? DEFAULT_JOURNAL_DIRECTORY;
}

export function normalizedJournalDirectoryOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/\\/gu, "/");
  if (!raw || raw.startsWith("/") || /^[a-z]:/iu.test(raw)) {
    return null;
  }
  const segments = raw.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  return segments.join("/");
}
