/**
 * Minimal promise semaphore. LibreOffice is memory-hungry, so the server
 * limits how many conversions run at once (default 1) and queues the rest.
 */
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore size must be a positive integer, got ${max}`);
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    // Hand the slot directly to the next waiter (no decrement/re-increment,
    // so a concurrent acquire can never over-admit).
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.active--;
    }
  }

  async use<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
