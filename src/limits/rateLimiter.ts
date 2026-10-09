import { QueueFullError } from "../errors/errors.js";
import { WaitAborted } from "../utils/abort.js";

interface Waiter {
  resolve: () => void;
  cleanup: () => void;
}

/**
 * Sliding-window start limiter: at most `limit` request starts in any window of
 * `intervalMs`. The full `limit` may be used as a burst. Waiters are served
 * FIFO and share a single timer. Per-process only.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #intervalMs: number;
  readonly #maxQueueSize: number;
  readonly #starts: number[] = [];
  readonly #queue = new Set<Waiter>();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(limit: number, intervalMs: number, maxQueueSize: number) {
    this.#limit = limit;
    this.#intervalMs = intervalMs;
    this.#maxQueueSize = maxQueueSize;
  }

  get queued(): number {
    return this.#queue.size;
  }

  acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new WaitAborted());
    if (this.#queue.size === 0 && this.#tryTake()) return Promise.resolve();
    if (this.#queue.size >= this.#maxQueueSize) {
      return Promise.reject(new QueueFullError("rate-limit", this.#maxQueueSize));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        this.#queue.delete(waiter);
        if (this.#queue.size === 0) this.#clearTimer();
        reject(new WaitAborted());
      };
      const waiter: Waiter = {
        resolve,
        cleanup: () => signal.removeEventListener("abort", onAbort),
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.add(waiter);
      this.#schedule();
    });
  }

  /** Drops the timer; pending waiters stay pending until their scope aborts. */
  dispose(): void {
    this.#clearTimer();
  }

  #tryTake(): boolean {
    const now = Date.now();
    while (this.#starts.length > 0 && this.#starts[0]! <= now - this.#intervalMs)
      this.#starts.shift();
    if (this.#starts.length < this.#limit) {
      this.#starts.push(now);
      return true;
    }
    return false;
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#queue.size === 0) return;
    const oldest = this.#starts[0] ?? Date.now();
    const delay = Math.max(1, oldest + this.#intervalMs - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#pump();
    }, delay);
  }

  #pump(): void {
    while (this.#queue.size > 0 && this.#tryTake()) {
      const waiter = this.#queue.values().next().value as Waiter;
      this.#queue.delete(waiter);
      waiter.cleanup();
      waiter.resolve();
    }
    this.#schedule();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
