import type { RoadSnapshot } from './local-roads';
import type { RoutingJob, RoutingResult } from './routing-protocol';

declare const __LOCAL_ROUTING_WORKER__: string;

export interface RoutingClient {
  route(snapshot: RoadSnapshot, legs: RoutingJob['legs'], gate?: RoutingJob['gate']): Promise<RoutingResult>;
  cancel(): void;
  configure?(timeoutMs: number): void;
}

/** The worker code is bundled into main.js; there is no remote code or routing API. */
export class LocalRoutingClient implements RoutingClient {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private nextId = 0;
  private timeoutMs = 8000;

  configure(timeoutMs: number): void {
    if (Number.isFinite(timeoutMs)) this.timeoutMs = Math.max(1000, Math.min(60000, Math.round(timeoutMs)));
  }
  private pending: { id: number; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

  async route(snapshot: RoadSnapshot, legs: RoutingJob['legs'], gate?: RoutingJob['gate']): Promise<RoutingResult> {
    if (this.pending) this.cancel();
    if (!this.worker) {
      this.workerUrl = URL.createObjectURL(new Blob([__LOCAL_ROUTING_WORKER__], { type: 'text/javascript' }));
      try { this.worker = new Worker(this.workerUrl); }
      catch (error) { this.cancel(); throw error; }
    }
    const worker = this.worker;
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(), this.timeoutMs);
      this.pending = { id, reject, timer };
      worker.onmessage = (event: MessageEvent<RoutingResult>) => {
        if (event.data.id !== this.pending?.id) return;
        clearTimeout(timer);
        this.pending = null;
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = () => { if (this.worker === worker) this.cancel(); };
      try { worker.postMessage({ id, graphKey: snapshot.key, features: snapshot.features, legs, ...(gate ? { gate } : {}) } satisfies RoutingJob); }
      catch { this.cancel(); }
    });
  }

  cancel(): void {
    const pending = this.pending;
    this.pending = null;
    if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Local road search stopped.')); }
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }
}
