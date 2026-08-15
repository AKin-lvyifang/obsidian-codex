import { TextDecoder } from "node:util";

export const ECHOINK_LOCAL_SECRETS_V1 =
  "echoink-local-secrets-v1" as const;
export const REDACTED_SECRET = "[REDACTED_SECRET]" as const;
export const VAULT_READ_TOOL_RESULT_LIMIT_BYTES = 32_000;
export const VAULT_WRITE_TOOL_RESULT_LIMIT_BYTES = 8_000;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const TRUNCATION_MARKER = "\n[TRUNCATED]";

const VALUE_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\bghp_[A-Za-z0-9]{12,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/gu
];

const CREDENTIAL_FIELD =
  /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential(?:value)?|client[_-]?secret|password|secret)["']?)\s*[:=]\s*)(["']?)((?!\[REDACTED_SECRET\])[^\s,"'}\]]+)(["']?)/giu;

export interface VaultToolResultEgressContext {
  readonly toolId: string;
  readonly effectType: "read" | "user_write";
  readonly egressPolicy: string;
  readonly redactionPolicy: typeof ECHOINK_LOCAL_SECRETS_V1;
  readonly byteLength: number;
  readonly text: string;
}

export interface VaultToolResultEgressPort {
  assertAllowed(
    context: Readonly<VaultToolResultEgressContext>
  ): Promise<void> | void;
}

export interface SecureVaultToolResultInput {
  readonly toolId: string;
  readonly effectType: "read" | "user_write";
  readonly egressPolicy: string;
  readonly value: unknown;
  readonly sizeLimitBytes: number;
  readonly egress: VaultToolResultEgressPort;
}

export interface SecureVaultToolResult {
  readonly text: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly redactionPolicy: typeof ECHOINK_LOCAL_SECRETS_V1;
}

/**
 * Fixed result order: serialize the complete bounded domain result, redact the
 * complete candidate, apply the final byte cap, and only then admit Egress.
 */
export async function secureVaultToolResult(
  input: Readonly<SecureVaultToolResultInput>
): Promise<Readonly<SecureVaultToolResult>> {
  const serialized = serializeToolResult(input.value);
  const redacted = redactEchoInkLocalSecretsV1(serialized);
  const limited = truncateUtf8(redacted, input.sizeLimitBytes);
  const byteLength = Buffer.byteLength(limited.text, "utf8");
  await input.egress.assertAllowed(Object.freeze({
    toolId: input.toolId,
    effectType: input.effectType,
    egressPolicy: input.egressPolicy,
    redactionPolicy: ECHOINK_LOCAL_SECRETS_V1,
    byteLength,
    text: limited.text
  }));
  return Object.freeze({
    text: limited.text,
    byteLength,
    truncated: limited.truncated,
    redactionPolicy: ECHOINK_LOCAL_SECRETS_V1
  });
}

export function redactEchoInkLocalSecretsV1(value: string): string {
  let redacted = value;
  for (const pattern of VALUE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const scheme = /^(?:Bearer|Basic)\s+/iu.exec(match)?.[0] ?? "";
      return `${scheme}${REDACTED_SECRET}`;
    });
  }
  redacted = redacted.replace(
    CREDENTIAL_FIELD,
    (_match, prefix: string, openingQuote: string) =>
      `${prefix}${openingQuote}${REDACTED_SECRET}${openingQuote}`
  );
  return redacted;
}

/** Default local-to-configured-provider policy used by the seven Vault Tools. */
export class EchoInkVaultToolEgressPolicy
implements VaultToolResultEgressPort {
  constructor(
    private readonly allowedPolicy = "echoink-configured-provider-v1"
  ) {}

  assertAllowed(context: Readonly<VaultToolResultEgressContext>): void {
    if (
      context.egressPolicy !== this.allowedPolicy
      || context.redactionPolicy !== ECHOINK_LOCAL_SECRETS_V1
      || !Number.isSafeInteger(context.byteLength)
      || context.byteLength < 0
    ) {
      throw new Error("vault_tool_egress_denied");
    }
  }
}

function serializeToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return "vault_tool_result_unserializable";
  }
}

function truncateUtf8(
  value: string,
  maxBytes: number
): Readonly<{ text: string; truncated: boolean }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("Vault Tool result size limit must be positive");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) {
    return Object.freeze({ text: value, truncated: false });
  }
  const marker = Buffer.from(TRUNCATION_MARKER, "utf8");
  const prefixLimit = Math.max(0, maxBytes - marker.length);
  const prefix = decodeUtf8Prefix(bytes.subarray(0, prefixLimit));
  return Object.freeze({
    text: `${prefix}${TRUNCATION_MARKER}`,
    truncated: true
  });
}

function decodeUtf8Prefix(bytes: Buffer): string {
  for (let trim = 0; trim <= Math.min(3, bytes.length); trim += 1) {
    try {
      return UTF8_DECODER.decode(
        trim === 0 ? bytes : bytes.subarray(0, bytes.length - trim)
      );
    } catch {
      // The byte boundary may split only the last UTF-8 scalar.
    }
  }
  return "";
}
