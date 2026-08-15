export const ECHOINK_EVENT_SCHEMA_VERSION = "echoink.event.v1" as const;

export type EchoInkEventSource =
  | "client"
  | "host"
  | "pi_projector"
  | "tool_gateway"
  | "domain_service"
  | "conversation_store"
  | "scheduler"
  | "external";

export type EchoInkEventDurability = "durable" | "ephemeral";

export type EchoInkPrivacyClass =
  | "public"
  | "internal"
  | "personal"
  | "sensitive"
  | "secret_prohibited";

export type EchoInkRetentionClass =
  | "transient"
  | "conversation"
  | "operational"
  | "audit"
  | "legal_hold";

export type EchoInkEventType =
  | "conversation.created"
  | "conversation.archived"
  | "conversation.reopened"
  | "conversation.deleted"
  | "turn.submitted"
  | "turn.running"
  | "turn.answered"
  | "turn.needs_attention"
  | "turn.abandoned"
  | "message.committed"
  | "message.deleted"
  | "message.stream.started"
  | "message.delta"
  | "run.created"
  | "run.running"
  | "run.waiting_approval"
  | "run.executing_tool"
  | "run.finalizing"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "runtime.cycle.started"
  | "runtime.cycle.completed"
  | "runtime.late_event_ignored"
  | "tool.requested"
  | "tool.awaiting_approval"
  | "tool.authorized"
  | "tool.running"
  | "tool.verifying"
  | "tool.completed"
  | "tool.denied"
  | "tool.expired"
  | "tool.failed"
  | "tool.cancelled"
  | "tool.uncertain"
  | "tool.progress"
  | "approval.prepared"
  | "approval.awaiting"
  | "approval.approved"
  | "approval.denied"
  | "approval.expired"
  | "approval.consumed"
  | "approval.revoked"
  | "grant.created"
  | "grant.revoked"
  | "domain.intent.committed"
  | "domain.receipt.committed"
  | "egress.prepared"
  | "egress.blocked"
  | "egress.submitting"
  | "egress.submitted"
  | "egress.completed"
  | "egress.failed"
  | "egress.submission_unknown"
  | "egress.redirect_received"
  | "usage.recorded"
  | "source.tombstoned";

export interface EchoInkEventV1 {
  schemaVersion: typeof ECHOINK_EVENT_SCHEMA_VERSION;
  eventId: string;
  eventType: EchoInkEventType;
  occurredAt: string;
  source: EchoInkEventSource;
  conversationId?: string;
  turnId?: string;
  runId?: string;
  toolCallId?: string;
  sequence: number;
  causationEventId?: string;
  correlationId?: string;
  durability: EchoInkEventDurability;
  privacyClass: EchoInkPrivacyClass;
  retentionClass: EchoInkRetentionClass;
  payload: Readonly<Record<string, unknown>>;
}

export type EchoInkEventDraft = Omit<
  EchoInkEventV1,
  "schemaVersion" | "eventId" | "occurredAt" | "sequence"
>;

export interface PiRunContext {
  conversationId: string;
  turnId: string;
  runId: string;
  correlationId: string;
  contextRevision: string;
  causationEventId?: string;
  privacyClass?: EchoInkPrivacyClass;
}

export interface FinalCandidate {
  candidateId: string;
  conversationId: string;
  turnId: string;
  runId: string;
  text: string;
  createdAt: string;
  source: "pi_message_end";
}

export interface PiContextMessage {
  source: "conversation_store";
  state: "committed";
  messageId: string;
  role: "user" | "assistant";
  content: string;
  committedAt: number;
}

export type PiInlineImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp";

export interface PiPreparedInlineImage {
  kind: "inline_image";
  preflight: "approved";
  data: string;
  mimeType: PiInlineImageMimeType;
}

export interface PiUnsupportedAttachment {
  kind: "file" | "pdf";
  mediaType?: string;
}

export type PiPromptAttachment =
  | PiPreparedInlineImage
  | PiUnsupportedAttachment;

export interface PiPromptInput {
  text: string;
  submittedAt: number;
  attachments?: readonly PiPromptAttachment[];
}

export interface PiMessageCodecInput {
  contextMessages: readonly PiContextMessage[];
  currentInput: PiPromptInput;
}

export interface EchoInkEventEnvelopePort {
  create(draft: EchoInkEventDraft): Promise<EchoInkEventV1>;
}

export interface EchoInkEventAppenderPort {
  append(event: EchoInkEventV1): Promise<void>;
}

export interface ToolCallRegistryResolveInput {
  runId: string;
  piToolCallId: string;
  toolName: string;
  argsDigest?: string;
}

export interface ToolCallRegistryPort {
  resolve(input: ToolCallRegistryResolveInput): Promise<{ toolCallId: string }>;
}

export const PI_COMPLETION_RECEIPT_SCHEMA_VERSION =
  "echoink.pi-completion-receipt.v1" as const;

/**
 * Durable proof returned only after the canonical Assistant Message and
 * Conversation CAS have both been committed and strictly read back.
 *
 * The receipt intentionally contains identities and digests only. Final text,
 * credentials, provider payloads, and Raw Pi identifiers are prohibited.
 */
export interface PiCompletionReceipt {
  schemaVersion: typeof PI_COMPLETION_RECEIPT_SCHEMA_VERSION;
  authorityId: string;
  storeSetId: string;
  runId: string;
  conversationId: string;
  turnId: string;
  contextRevision: string;
  finalCandidateId: string;
  messageId: string;
  commitId: string;
  revision: number;
  payloadDigest: string;
}

export interface PiCommittedCompletion {
  receipt: PiCompletionReceipt;
  text: string;
}

export interface CompletionBarrierPort {
  readonly authorityId: string;
  readonly storeSetId: string;
  complete(input: {
    context: PiRunContext;
    finalCandidate?: FinalCandidate;
  }): Promise<PiCompletionReceipt>;
  /**
   * Recovers a canonical Assistant Message that may have committed before the
   * Run terminal event. A missing result means the caller must not replay Pi
   * after a host restart.
   */
  recoverCommitted(input: {
    context: PiRunContext;
  }): Promise<PiCommittedCompletion | null>;
  /**
   * Strictly reads the canonical Assistant Message identified by a durable
   * completion receipt. This is the only replay path for completed Runs.
   */
  readCommitted(input: {
    context: PiRunContext;
    receipt: PiCompletionReceipt;
  }): Promise<PiCommittedCompletion>;
}

export interface PublicTextSanitizerPort {
  sanitize(
    text: string,
    field: "message_delta" | "final_candidate" | "tool_progress"
  ): string | Promise<string>;
}

export interface ProductIdGeneratorPort {
  next(kind: "final_candidate" | "message" | "run" | "tool_call"): string;
}
