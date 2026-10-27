export const SHARED_HTTP_CACHE_SCOPE = 'Shared Obsidian HTTP cache (includes Maps and other plugins)';
export const SHARED_HTTP_CACHE_INTERVAL_MS = 30000;

export interface SharedHttpCacheSnapshot {
  scope: string;
  available: boolean;
  bytes: number | null;
  baselineBytes: number | null;
  /** Signed change since the first successful reading in this plugin session. */
  sessionDeltaBytes: number | null;
  measuredAt: number | null;
}

export type SharedHttpCacheProbe = () => number | null | Promise<number | null>;
export interface SharedHttpCacheMonitorOptions {
  probe?: SharedHttpCacheProbe;
  now?: () => number;
  onChange?: (snapshot: SharedHttpCacheSnapshot) => void;
  intervalMs?: number;
}

const validBytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object';

/** Read Electron's aggregate HTTP cache counter, without scanning or clearing files. */
export function createSharedHttpCacheProbe(load: unknown = (globalThis as { require?: unknown }).require): SharedHttpCacheProbe {
  return async () => {
    try {
      if (typeof load !== 'function') return null;
      // Resolve at runtime so the addon stays compatible with mobile and does not bundle Electron.
      const remote: unknown = load('@electron/remote');
      if (!record(remote) || typeof remote.getCurrentWebContents !== 'function') return null;
      const contents: unknown = remote.getCurrentWebContents.call(remote);
      if (!record(contents) || !record(contents.session)) return null;
      const session = contents.session;
      if (typeof session.getCacheSize !== 'function') return null;
      const result: unknown = await session.getCacheSize.call(session);
      return validBytes(result) ? result : null;
    } catch { return null; }
  };
}

/** Optional, throttled session-wide telemetry; it cannot attribute cache growth to Maps. */
export class SharedHttpCacheMonitor {
  private readonly probe: SharedHttpCacheProbe;
  private readonly now: () => number;
  private readonly onChange?: SharedHttpCacheMonitorOptions['onChange'];
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<SharedHttpCacheSnapshot> | null = null;
  private generation = 0;
  private stopped = false;
  private lastAttemptAt: number | null = null;
  private bytes: number | null = null;
  private baselineBytes: number | null = null;
  private measuredAt: number | null = null;

  constructor(options: SharedHttpCacheMonitorOptions = {}) {
    this.probe = options.probe ?? createSharedHttpCacheProbe();
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
    this.intervalMs = typeof options.intervalMs === 'number' && Number.isFinite(options.intervalMs)
      ? Math.max(1000, options.intervalMs) : SHARED_HTTP_CACHE_INTERVAL_MS;
  }

  start(): Promise<SharedHttpCacheSnapshot> {
    if (this.timer !== null) return this.sampleNow();
    this.stopped = false;
    this.timer = setInterval(() => { void this.sampleNow(); }, this.intervalMs);
    return this.sampleNow(true);
  }

  /** Save callbacks use the default throttle; force only when an immediate reading is useful. */
  sampleNow(force = false): Promise<SharedHttpCacheSnapshot> {
    if (this.stopped) return Promise.resolve(this.snapshot());
    if (this.pending) return this.pending;
    const attemptedAt = this.now();
    if (!force && this.lastAttemptAt !== null && attemptedAt - this.lastAttemptAt < this.intervalMs) {
      return Promise.resolve(this.snapshot());
    }
    this.lastAttemptAt = attemptedAt;
    const generation = this.generation;
    const operation = Promise.resolve().then(() => this.probe()).catch(() => null).then(value => {
      if (this.stopped || generation !== this.generation) return this.snapshot();
      const next = validBytes(value) ? value : null;
      const changed = this.bytes !== next;
      this.bytes = next;
      if (next !== null) this.baselineBytes ??= next;
      this.measuredAt = this.now();
      const snapshot = this.snapshot();
      if (changed) {
        try { this.onChange?.(snapshot); } catch { /* Display failures cannot interrupt routing. */ }
      }
      return snapshot;
    }).finally(() => { if (this.pending === operation) this.pending = null; });
    this.pending = operation;
    return operation;
  }

  /** Invalidate any pending native read so plugin unload cannot trigger a late UI update. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    this.generation++;
    this.pending = null;
  }

  snapshot(): SharedHttpCacheSnapshot {
    return {
      scope: SHARED_HTTP_CACHE_SCOPE,
      available: this.bytes !== null,
      bytes: this.bytes,
      baselineBytes: this.baselineBytes,
      sessionDeltaBytes: this.bytes !== null && this.baselineBytes !== null ? this.bytes - this.baselineBytes : null,
      measuredAt: this.measuredAt,
    };
  }
}
