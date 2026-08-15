export class ResourceMutationError extends Error {
  constructor(
    message: string,
    readonly rollbackSafe: boolean,
    readonly candidateMayBePersisted: boolean,
    readonly authorityKnown: boolean,
    options: ErrorOptions = {}
  ) {
    super(message, options);
    this.name = "ResourceMutationError";
  }
}

export function resourceMutationRollbackIsSafe(error: unknown): boolean {
  return error instanceof ResourceMutationError && error.rollbackSafe;
}

export async function runResourceMutationWithReload<T>(options: {
  snapshot(): T;
  restore(value: T): void;
  mutate(): void;
  save(previous: T): Promise<void>;
  closeRuntimeResources(): Promise<void>;
  reloadRuntime(): Promise<void>;
}): Promise<void> {
  const previous = options.snapshot();
  let candidate: T | null = null;
  let persisted = false;
  try {
    options.mutate();
    candidate = options.snapshot();
    await options.save(previous);
    persisted = true;
    await options.closeRuntimeResources();
    await options.reloadRuntime();
  } catch (error) {
    if (!persisted || !candidate) throw error;
    options.restore(previous);
    try {
      await options.save(candidate);
      await options.closeRuntimeResources();
      await options.reloadRuntime();
    } catch (rollbackError) {
      throw new ResourceMutationError(
        "Resource runtime reload failed and compensation is uncertain",
        false,
        true,
        rollbackError instanceof ResourceMutationError
          ? rollbackError.authorityKnown
          : false,
        { cause: rollbackError }
      );
    }
    throw new ResourceMutationError(
      "Resource runtime reload failed; previous resources were restored",
      true,
      false,
      true,
      { cause: error }
    );
  }
}
