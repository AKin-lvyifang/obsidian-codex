/** Stable settings projection used by the current Pi Conversation UI. */
export interface EchoInkConversationSessionShell<
  TMessage,
  TContextLedger = unknown,
  TTokenUsage = unknown
> {
  id: string;
  title: string;
  piSessionId?: string;
  defaultMemoryMode?: "normal" | "no_memory";
  bodyAuthority?: "pi_session_only";
  cwd: string;
  messages: TMessage[];
  tokenUsage?: TTokenUsage;
  /** Cache only; Pi Session remains authoritative. */
  contextLedger?: TContextLedger;
  createdAt: number;
  updatedAt: number;
}
