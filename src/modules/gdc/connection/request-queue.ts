export interface GdcQueuedRequest {
  readonly run: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

export class GdcRequestQueue {
  private readonly items: GdcQueuedRequest[] = [];
  private running = false;

  enqueue<T>(run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.items.push({
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      void this.drain();
    });
  }

  clear(error: Error): void {
    while (this.items.length > 0) {
      const item = this.items.shift();
      item?.reject(error);
    }
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.items.length > 0) {
        const item = this.items.shift();
        if (!item) {
          continue;
        }

        try {
          const result = await item.run();
          item.resolve(result);
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
