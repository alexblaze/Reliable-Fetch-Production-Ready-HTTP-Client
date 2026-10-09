import { QueueFullError } from "../errors/errors.js";
import { WaitAborted } from "../utils/abort.js";

interface Waiter {
  resolve: (release: () => void) => void;
  cleanup: () => void;
}

/**
 * FIFO concurrency limiter. A Set preserves insertion order and gives O(1)
 * removal, so cancelled waiters leave no residue in the queue.
 */
export class ConcurrencyLimiter {
  readonly #limit: number;
  readonly #maxQueueSize: number;
  readonly #queue = new Set<Waiter>();
  #active = 0;

  constructor(limit: number, maxQueueSize: number) {
    this.#limit = limit;
    this.#maxQueueSize = maxQueueSize;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.size;
  }

  /** Resolves with an idempotent `release`. Rejects with `WaitAborted` or `QueueFullError`. */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new WaitAborted());
    if (this.#active < this.#limit && this.#queue.size === 0) {
      this.#active++;
      return Promise.resolve(this.#makeRelease());
    }
    if (this.#queue.size >= this.#maxQueueSize) {
      return Promise.reject(new QueueFullError("concurrency", this.#maxQueueSize));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#queue.delete(waiter);
        reject(new WaitAborted());
      };
      const waiter: Waiter = {
        resolve,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.add(waiter);
    });
  }

  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active--;
      this.#drain();
    };
  }

  #drain(): void {
    while (this.#active < this.#limit) {
      const next = this.#queue.values().next();
      if (next.done) return;
      const waiter = next.value;
      this.#queue.delete(waiter);
      waiter.cleanup();
      this.#active++;
      waiter.resolve(this.#makeRelease());
    }
  }
}
