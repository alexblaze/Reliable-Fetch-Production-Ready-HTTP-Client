export type AbortCause =
  "caller" | "client-closed" | "queue-timeout" | "attempt-timeout" | "total-timeout";

/** Internal marker thrown by waiters when their scope is aborted. Mapped to a public error by the client. */
export class WaitAborted extends Error {
  constructor() {
    super("wait aborted");
    this.name = "WaitAborted";
  }
}

/**
 * A cancellable scope with a recorded cause. It never mutates the signals it
 * listens to; every listener and timer it registers is removed in `dispose()`.
 */
export class Scope {
  readonly #controller = new AbortController();
  readonly #cleanups: Array<() => void> = [];
  #cause: AbortCause | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get cause(): AbortCause | undefined {
    return this.#cause;
  }

  abort(cause: AbortCause): void {
    if (this.#cause !== undefined) return;
    this.#cause = cause;
    this.#controller.abort();
  }

  linkSignal(source: AbortSignal, cause: AbortCause | (() => AbortCause)): void {
    const resolve = () => (typeof cause === "function" ? cause() : cause);
    if (source.aborted) {
      this.abort(resolve());
      return;
    }
    const onAbort = () => this.abort(resolve());
    source.addEventListener("abort", onAbort, { once: true });
    this.#cleanups.push(() => source.removeEventListener("abort", onAbort));
  }

  linkScope(parent: Scope): void {
    this.linkSignal(parent.signal, () => parent.cause ?? "caller");
  }

  startTimer(ms: number, cause: AbortCause): void {
    const timer = setTimeout(() => this.abort(cause), ms);
    this.#cleanups.push(() => clearTimeout(timer));
  }

  dispose(): void {
    for (const cleanup of this.#cleanups) cleanup();
    this.#cleanups.length = 0;
  }
}

/** Cancellation-aware sleep. Rejects with `WaitAborted` and always clears its timer/listener. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new WaitAborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WaitAborted());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Releases an unwanted body without waiting for it: awaiting cancel() on a stalled
 * connection could otherwise block the retry loop indefinitely.
 */
export function discardBody(source: { cancel(): Promise<void> } | null | undefined): void {
  if (!source) return;
  try {
    source.cancel().catch(() => undefined);
  } catch {
    /* already locked or closed */
  }
}
