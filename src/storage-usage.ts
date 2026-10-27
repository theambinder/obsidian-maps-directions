export const STORAGE_SCOPE = 'Maps Directions data.json (logical file size)';

export interface StorageSnapshot {
  scope: string;
  available: boolean;
  /** Exact logical bytes reported for the addon data file, not allocated disk blocks. */
  dataBytes: number | null;
  baselineBytes: number | null;
  /** Signed change since the first successful measurement in this plugin session. */
  sessionDeltaBytes: number | null;
  measuredAt: number | null;
  /** The shared Chromium HTTP cache is outside the measured file scope. */
  browserCacheBytes: null;
}

export interface StorageStatLike { size: number; type?: string }
export interface StorageAdapterLike { stat(path: string): Promise<StorageStatLike | null> }
const bytes = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Observe only the addon's own data file. No directory scans or payload estimates. */
export class StorageUsageTracker {
  private dataBytes: number | null = null;
  private baselineBytes: number | null = null;
  private measuredAt: number | null = null;

  constructor(
    private readonly onChange: (snapshot: StorageSnapshot) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  observe(value: number): boolean {
    if (!bytes(value)) return false;
    const changed = this.dataBytes !== value;
    this.dataBytes = value;
    this.baselineBytes ??= value;
    this.measuredAt = this.now();
    if (changed) this.report();
    return true;
  }

  unavailable(): void {
    const changed = this.dataBytes !== null;
    this.dataBytes = null;
    this.measuredAt = this.now();
    if (changed) this.report();
  }

  snapshot(): StorageSnapshot {
    return {
      scope: STORAGE_SCOPE,
      available: this.dataBytes !== null,
      dataBytes: this.dataBytes,
      baselineBytes: this.baselineBytes,
      sessionDeltaBytes: this.dataBytes !== null && this.baselineBytes !== null ? this.dataBytes - this.baselineBytes : null,
      measuredAt: this.measuredAt,
      browserCacheBytes: null,
    };
  }

  private report(): void {
    try { this.onChange(this.snapshot()); } catch { /* A display callback must not interrupt persistence. */ }
  }
}

/** Call after loading data and after a successful save, using the vault adapter. */
export async function refreshStorageUsage(adapter: StorageAdapterLike, path: string, tracker: StorageUsageTracker): Promise<StorageSnapshot> {
  try {
    const stat = await adapter.stat(path);
    if (stat === null) tracker.observe(0);
    else if (stat.type === 'folder' || !tracker.observe(stat.size)) tracker.unavailable();
  } catch {
    tracker.unavailable();
  }
  return tracker.snapshot();
}

/** Binary units match measured file bytes; rounded display does not imply allocated blocks. */
export function formatStorageBytes(value: unknown): string {
  if (!bytes(value)) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(1)} ${units[unit]}`;
}

/** Signed growth is relative to plugin startup; a smaller data file can be negative. */
export function formatStorageDelta(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return '—';
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${formatStorageBytes(Math.abs(value))}`;
}
