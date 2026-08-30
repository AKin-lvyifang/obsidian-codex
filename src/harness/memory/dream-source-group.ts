const EXPERIENCE_PROFILE_SOURCE_PREFIX = "experience:";
const SHA256_HEX = /^[a-f0-9]{64}$/u;

export function conversationIdFromMemorySource(source: string): string | null {
  if (!source.startsWith("pi://")) return null;
  const pathPart = source.slice("pi://".length).split("?", 1)[0];
  const segments = pathPart.split("/");
  if (segments.length < 2) return null;
  try {
    return decodeURIComponent(segments[1]).trim() || null;
  } catch {
    return null;
  }
}

export function productRunIdFromMemorySource(source: string): string | null {
  if (!source.startsWith("pi://")) return null;
  const queryIndex = source.indexOf("?");
  if (queryIndex < 0) return null;
  try {
    const values = new URLSearchParams(source.slice(queryIndex + 1)).getAll("productRun");
    if (values.length !== 1) return null;
    return values[0].trim() || null;
  } catch {
    return null;
  }
}

export function memorySourceGroup(source: string, memoryId: string): Readonly<{
  contextId: string;
  independentContext: boolean;
}> {
  const productRunId = productRunIdFromMemorySource(source);
  if (productRunId) {
    return Object.freeze({ contextId: `task:${productRunId}`, independentContext: true });
  }
  const conversationId = conversationIdFromMemorySource(source);
  return conversationId
    ? Object.freeze({ contextId: `conversation:${conversationId}`, independentContext: true })
    : Object.freeze({ contextId: `memory:${memoryId}`, independentContext: false });
}

export function experienceSourceGroup(productRunId: string): string {
  return `task:${productRunId}`;
}

export function experienceProfileSourceId(
  productRunId: string,
  fingerprint: string
): string | null {
  if (!productRunId.trim() || !SHA256_HEX.test(fingerprint)) return null;
  try {
    return `${EXPERIENCE_PROFILE_SOURCE_PREFIX}${encodeURIComponent(productRunId)}:${fingerprint}`;
  } catch {
    return null;
  }
}

export function productRunIdFromExperienceProfileSourceId(sourceId: string): string | null {
  if (!sourceId.startsWith(EXPERIENCE_PROFILE_SOURCE_PREFIX)) return null;
  const value = sourceId.slice(EXPERIENCE_PROFILE_SOURCE_PREFIX.length);
  const separator = value.lastIndexOf(":");
  if (separator <= 0 || !SHA256_HEX.test(value.slice(separator + 1))) return null;
  try {
    return decodeURIComponent(value.slice(0, separator)).trim() || null;
  } catch {
    return null;
  }
}

export function invalidatedMemoryProductRunIds(
  records: readonly Readonly<{ source: string; status: string }>[]
): ReadonlySet<string> {
  const current = new Set(records
    .filter((record) => record.status === "current")
    .map((record) => productRunIdFromMemorySource(record.source))
    .filter((value): value is string => value !== null));
  return new Set(records
    .filter((record) => record.status !== "current")
    .map((record) => productRunIdFromMemorySource(record.source))
    .filter((value): value is string => value !== null && !current.has(value)));
}
