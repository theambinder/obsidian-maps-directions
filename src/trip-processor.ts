import type { MapLike } from './contracts';
import { prepareBackgroundRoads, type BackgroundMapFactory } from './background-roads';
import { PreparationQueue } from './auto-preparation';
import { DetailedRoadMemory } from './detailed-road-memory';
import type { RoutingClient } from './local-routing-client';
import type { RoadRoute } from './routing-protocol';
import { exceedsRoadDistance, roadDistanceLimitReason, planTripConnection, subdivideTripArea, TripQueue } from './trip-queue';
import type { WorkloadProfile } from './workload-settings';

export interface TripProcessorProgress { key: string; completed: number; total: number; message: string }
export interface TripProcessorOptions {
  original: MapLike;
  keys: readonly string[];
  ledger: TripQueue;
  serial: PreparationQueue;
  factory: BackgroundMapFactory;
  client: RoutingClient;
  profile: () => WorkloadProfile;
  signal: AbortSignal;
  run?: typeof prepareBackgroundRoads;
  visible?: () => boolean;
  onProgress?: (progress: TripProcessorProgress) => void;
  onRoute?: (key: string, route: RoadRoute) => void;
  /** null/undefined/zero leaves road distance unlimited for existing callers. */
  maxDistanceKm?: number | null | (() => number | null);
}

function workingLimit(profile: WorkloadProfile): string {
  return profile.mode === 'maximum' ? 'Working data limit in Maximum. This connection needs a different search strategy or regional routing data; progress is saved.' : `Working data limit in ${profile.label}. Select a larger workload mode and Resume.`;
}

function abortError(): Error { const error = new Error('Trip preparation paused.'); error.name = 'AbortError'; return error; }
export function tripPause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Each connection owns a temporary road network. Finished geometry is durable. */
export async function processTripQueue(options: TripProcessorOptions): Promise<void> {
  const { ledger, client, signal } = options;
  let activeKey: string | null = null;
  const distanceLimit = (): number | null | undefined => typeof options.maxDistanceKm === 'function' ? options.maxDistanceKm() : options.maxDistanceKm;
  const directIfOverLimit = (task: { key: string; from: [number, number]; to: [number, number] }): boolean => {
    const limit = distanceLimit();
    if (!exceedsRoadDistance(task.from, task.to, limit)) return false;
    ledger.setDirect(task.key, roadDistanceLimitReason(task.from, task.to, limit!));
    options.onProgress?.({ key: task.key, completed: 0, total: 0, message: 'Straight connection: road calculation distance limit.' });
    return true;
  };
  const stopWorker = (): void => client.cancel();
  signal.addEventListener('abort', stopWorker, { once: true });
  try {
    while (!signal.aborted) {
      const task = ledger.next(options.keys);
      if (!task) break;
      if (directIfOverLimit(task)) continue;
      if (options.visible && !options.visible()) throw abortError();
      if (!ledger.start(task.key)) continue;
      activeKey = task.key;
      const profile = options.profile();
      client.configure?.(profile.workerTimeoutMs);
      const memory = new DetailedRoadMemory({ features: profile.maxRoadFeatures, positions: profile.maxRoadPositions });
      const detailedCoverage = planTripConnection(task.from, task.to).detailedCoverage;
      let readyAreas = 0, unavailableAreas = 0, found = false, workerLimited = false;
      try {
        while (!signal.aborted) {
          const current = ledger.get(task.key);
          if (!current || current.state !== 'preparing' || current.nextArea >= current.areas.length || found) break;
          const start = current.nextArea;
          const chunk = current.areas.slice(start, start + profile.areasPerChunk);
          let subdivided = false, workingLimited = false;
          options.onProgress?.({ key: task.key, completed: start, total: current.areas.length, message: `Preparing connection: ${start}/${current.areas.length} areas.` });
          const result = await options.serial.run(signal, async () => {
            if (signal.aborted || options.visible && !options.visible()) throw abortError();
            if (directIfOverLimit(task)) return { completed: 0, total: 0, ready: 0, timedOut: false };
            return (options.run ?? prepareBackgroundRoads)(options.original, chunk, {
              factory: options.factory, signal,
              viewportWidth: profile.viewportWidth, viewportHeight: profile.viewportHeight, tileCacheSize: profile.tileCacheSize,
              roadLimits: { maxFeatures: profile.maxRoadFeatures, maxPositions: profile.maxRoadPositions },
              timeoutMs: 8000, totalTimeoutMs: 120000,
              onProgress: progress => {
                if (!signal.aborted) options.onProgress?.({ key: task.key, completed: start + progress.completed, total: ledger.get(task.key)?.areas.length ?? current.areas.length, message: 'Preparing roads in small chunks.' });
              },
              onSnapshot: async (snapshot, chunkSignal, area) => {
                if (signal.aborted || chunkSignal.aborted || ledger.get(task.key)?.state !== 'preparing') return false;
                if (directIfOverLimit(task)) return false;
                const index = start + (area?.index ?? 0);
                if (area?.waitTimedOut) unavailableAreas++;
                if (snapshot.state === 'limited') {
                  ledger.checkpoint(task.key, index);
                  const target = current.areas[index];
                  if (target?.zoom < 14) { unavailableAreas++; return true; }
                  const children = target && target.zoom < 16 ? subdivideTripArea(target) : [];
                  if (children.length && ledger.replaceArea(task.key, index, children)) subdivided = true;
                  else { workingLimited = true; ledger.pause(task.key, workingLimit(profile)); }
                  return false;
                }
                if (snapshot.state !== 'ready') { unavailableAreas++; return true; }
                readyAreas++;
                const roads = memory.merge(snapshot);
                if (roads.state !== 'ready') { unavailableAreas++; return true; }
                const stop = (): void => client.cancel();
                chunkSignal.addEventListener('abort', stop, { once: true });
                try {
                  const result = await client.route(roads, [{ from: task.from, to: task.to }]);
                  if (signal.aborted || chunkSignal.aborted || ledger.get(task.key)?.state !== 'preparing') return false;
                  if (directIfOverLimit(task)) return false;
                  const route = result.routes[0];
                  workerLimited ||= result.stats.truncated;
                  if (route && route.coordinates.length >= 2 && Number.isFinite(route.distance)) {
                    ledger.checkpoint(task.key, index + 1);
                    found = ledger.finish(task.key, 'ready', current.areas.some(area => area.zoom < 14) ? 'Approximate path from available road geometry.' : undefined, route);
                    if (found) options.onRoute?.(task.key, route);
                    return false;
                  }
                  return true;
                } finally { chunkSignal.removeEventListener('abort', stop); }
              },
            });
          });
          if (signal.aborted) throw abortError();
          if (!subdivided) ledger.checkpoint(task.key, Math.min(current.areas.length, start + result.completed));
          options.onProgress?.({ key: task.key, completed: ledger.get(task.key)?.nextArea ?? start, total: ledger.get(task.key)?.areas.length ?? current.areas.length, message: found ? 'Road path found and saved.' : 'Connection progress saved.' });
          if (found || workingLimited) break;
          if (result.completed === 0) {
            ledger.pause(task.key, 'Chunk loading time limit reached. Resume retries this connection; previous results are saved.');
            break;
          }
          if (profile.pauseMs > 0) {
            // Eco releases the worker graph during pauses; bounded road lines remain only for this connection.
            if (profile.mode === 'eco') client.cancel();
            await tripPause(profile.pauseMs, signal);
          }
        }
        if (signal.aborted) throw abortError();
        const final = ledger.get(task.key);
        if (final?.state === 'preparing') {
          if (workerLimited || memory.stats().evicted) ledger.pause(task.key, workingLimit(profile));
          else if (!detailedCoverage) ledger.finish(task.key, 'unavailable', 'The regional connection was checked at coarse map detail. A complete regional routing graph is required to resolve it.');
          else if (!readyAreas || unavailableAreas) ledger.finish(task.key, 'unavailable', 'Some required detailed road areas were unavailable. Retry when map data is available.');
          else ledger.finish(task.key, 'no-path', 'No connected walking path was found in the checked road data.');
        }
      } catch (error) {
        if (signal.aborted || options.visible && !options.visible()) throw error;
        ledger.pause(task.key, 'The local search could not finish within the working budget. Resume or select a larger workload mode.');
      } finally {
        memory.clear(); client.cancel();
      }
      activeKey = null;
      const profileAfter = options.profile();
      if (ledger.next(options.keys) && profileAfter.pauseMs > 0) await tripPause(profileAfter.pauseMs, signal);
    }
  } finally {
    signal.removeEventListener('abort', stopWorker);
    client.cancel();
    if (activeKey && ledger.get(activeKey)?.state === 'preparing') ledger.retry(activeKey);
  }
}
