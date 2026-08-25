import {
  cloneEchoInkTurnInteraction,
  normalizeEchoInkQuestionAnswers,
  type EchoInkQuestionAnswer,
  type EchoInkQuestionInteraction
} from "../types/conversation-turn";

export interface PiTurnInteractionIdentity {
  readonly conversationId: string;
  readonly piSessionId: string;
  readonly productRunId: string;
  readonly interactionId: string;
}

export interface PiTurnInteractionWaitInput extends PiTurnInteractionIdentity {
  readonly interaction: Readonly<EchoInkQuestionInteraction>;
  readonly signal?: AbortSignal;
}

export interface PiTurnInteractionDecisionBinding {
  readonly interaction: Readonly<EchoInkQuestionInteraction>;
  submit(answers: readonly Readonly<EchoInkQuestionAnswer>[]): boolean;
}

interface InteractionWaiter extends PiTurnInteractionIdentity {
  readonly key: string;
  readonly interaction: Readonly<EchoInkQuestionInteraction>;
  readonly resolve: (answers: readonly Readonly<EchoInkQuestionAnswer>[]) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

/**
 * One-shot live bridge between a structured Pi Question Tool and the current
 * Conversation view. Durable answers stay in Pi Session; this broker keeps no
 * history and rejects stale or repeated submissions.
 */
export class PiTurnInteractionBroker {
  private readonly waiters = new Map<string, InteractionWaiter>();
  private disposed = false;

  waitForAnswers(
    input: Readonly<PiTurnInteractionWaitInput>
  ): Promise<readonly Readonly<EchoInkQuestionAnswer>[]> {
    const identity = normalizeIdentity(input);
    const key = identityKey(identity);
    if (this.disposed) return Promise.reject(new Error("pi_turn_interaction_broker_disposed"));
    if (this.waiters.has(key)) return Promise.reject(new Error("pi_turn_interaction_waiter_conflict"));
    if (input.signal?.aborted) return Promise.reject(new Error("pi_turn_interaction_cancelled"));
    const interaction = cloneEchoInkTurnInteraction(input.interaction);
    if (interaction.kind !== "question") {
      return Promise.reject(new Error("pi_turn_interaction_kind_invalid"));
    }
    if (
      interaction.conversationId !== identity.conversationId
      || interaction.piSessionId !== identity.piSessionId
      || interaction.turnId !== identity.productRunId
      || interaction.interactionId !== identity.interactionId
    ) return Promise.reject(new Error("pi_turn_interaction_identity_mismatch"));

    return new Promise((resolve, reject) => {
      let waiter!: InteractionWaiter;
      const onAbort = input.signal ? () => this.abortWaiter(waiter) : undefined;
      waiter = {
        ...identity,
        key,
        interaction,
        resolve,
        reject,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(onAbort ? { onAbort } : {})
      };
      if (input.signal && onAbort) {
        input.signal.addEventListener("abort", onAbort, { once: true });
      }
      this.waiters.set(key, waiter);
    });
  }

  bindingFor(
    input: Readonly<PiTurnInteractionIdentity>
  ): PiTurnInteractionDecisionBinding | null {
    if (this.disposed) return null;
    const identity = normalizeIdentity(input);
    const waiter = this.waiters.get(identityKey(identity));
    if (!waiter) return null;
    return Object.freeze({
      interaction: cloneEchoInkTurnInteraction(waiter.interaction) as Readonly<EchoInkQuestionInteraction>,
      submit: (answers: readonly Readonly<EchoInkQuestionAnswer>[]) =>
        this.submit(waiter, answers)
    });
  }

  cancelPending(input: Readonly<PiTurnInteractionIdentity>): boolean {
    if (this.disposed) return false;
    const identity = normalizeIdentity(input);
    const waiter = this.waiters.get(identityKey(identity));
    if (!waiter) return false;
    this.abortWaiter(waiter);
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiter of [...this.waiters.values()]) {
      this.remove(waiter);
      waiter.reject(new Error("pi_turn_interaction_broker_disposed"));
    }
  }

  private submit(
    waiter: InteractionWaiter,
    answers: readonly Readonly<EchoInkQuestionAnswer>[]
  ): boolean {
    if (this.disposed || this.waiters.get(waiter.key) !== waiter) return false;
    let normalized: readonly Readonly<EchoInkQuestionAnswer>[];
    try {
      normalized = normalizeEchoInkQuestionAnswers(waiter.interaction, answers);
    } catch {
      return false;
    }
    this.remove(waiter);
    waiter.resolve(normalized);
    return true;
  }

  private abortWaiter(waiter: InteractionWaiter): void {
    if (this.waiters.get(waiter.key) !== waiter) return;
    this.remove(waiter);
    waiter.reject(new Error("pi_turn_interaction_cancelled"));
  }

  private remove(waiter: InteractionWaiter): void {
    if (this.waiters.get(waiter.key) === waiter) this.waiters.delete(waiter.key);
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  }
}

function normalizeIdentity(
  input: Readonly<PiTurnInteractionIdentity>
): PiTurnInteractionIdentity {
  return Object.freeze({
    conversationId: requiredIdentity(input.conversationId, "conversationId"),
    piSessionId: requiredIdentity(input.piSessionId, "piSessionId"),
    productRunId: requiredIdentity(input.productRunId, "productRunId"),
    interactionId: requiredIdentity(input.interactionId, "interactionId")
  });
}

function requiredIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(normalized)) {
    throw new TypeError(`pi_turn_interaction_${label}_invalid`);
  }
  return normalized;
}

function identityKey(identity: Readonly<PiTurnInteractionIdentity>): string {
  return [
    identity.conversationId,
    identity.piSessionId,
    identity.productRunId,
    identity.interactionId
  ].join("\0");
}
