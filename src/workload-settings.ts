export type WorkloadMode = 'eco' | 'balanced' | 'maximum';

export interface WorkloadSettings {
  mode: WorkloadMode;
  /** null uses the selected mode's pause. */
  pauseMs: number | null;
  /** Straight-line endpoint distance; zero leaves road routing unlimited. */
  maxDistanceKm: number;
}

export interface WorkloadProfile {
  mode: WorkloadMode;
  label: string;
  pauseMs: number;
  areasPerChunk: number;
  viewportWidth: number;
  viewportHeight: number;
  tileCacheSize: number;
  maxRoadFeatures: number;
  maxRoadPositions: number;
  workerTimeoutMs: number;
  maxDistanceKm: number;
}

export const DEFAULT_WORKLOAD_SETTINGS: Readonly<WorkloadSettings> = Object.freeze({ mode: 'eco', pauseMs: null, maxDistanceKm: 30 });

const PROFILES: Readonly<Record<WorkloadMode, Readonly<Omit<WorkloadProfile, 'maxDistanceKm'>>>> = Object.freeze({
  eco: Object.freeze({ mode: 'eco', label: 'Eco', pauseMs: 1000, areasPerChunk: 2,
    viewportWidth: 768, viewportHeight: 512, tileCacheSize: 8,
    maxRoadFeatures: 6000, maxRoadPositions: 50000, workerTimeoutMs: 8000 }),
  balanced: Object.freeze({ mode: 'balanced', label: 'Balanced', pauseMs: 250, areasPerChunk: 4,
    viewportWidth: 1024, viewportHeight: 768, tileCacheSize: 16,
    maxRoadFeatures: 12000, maxRoadPositions: 100000, workerTimeoutMs: 12000 }),
  maximum: Object.freeze({ mode: 'maximum', label: 'Maximum', pauseMs: 0, areasPerChunk: 8,
    viewportWidth: 1280, viewportHeight: 768, tileCacheSize: 32,
    maxRoadFeatures: 24000, maxRoadPositions: 200000, workerTimeoutMs: 20000 }),
});

export function readWorkloadSettings(raw: unknown): WorkloadSettings {
  const value = raw && typeof raw === 'object' ? raw as Partial<WorkloadSettings> : {};
  const mode = value.mode === 'balanced' || value.mode === 'maximum' ? value.mode : 'eco';
  const pause = value.pauseMs;
  const distance = value.maxDistanceKm;
  return { mode, pauseMs: typeof pause === 'number' && Number.isFinite(pause) ? Math.max(0, Math.min(60000, Math.round(pause))) : null,
    maxDistanceKm: typeof distance === 'number' && Number.isFinite(distance) && distance >= 0 ? distance : 30 };
}

/** These are concrete work limits, not promises about CPU percentage or RAM usage. */
export function workloadProfile(settings: Partial<WorkloadSettings>): WorkloadProfile {
  const normalized = readWorkloadSettings(settings);
  return { ...PROFILES[normalized.mode], pauseMs: normalized.pauseMs ?? PROFILES[normalized.mode].pauseMs, maxDistanceKm: normalized.maxDistanceKm };
}
