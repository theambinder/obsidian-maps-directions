import type { FeatureCollection, MapLike, MapsViewLike, OverlayLike } from './contracts';
import { buildDirections, normalizeLongitude } from './geometry';
import { collectLocalRoads, type RoadSnapshot } from './local-roads';
import { LocalRoutingClient, type RoutingClient } from './local-routing-client';
import type { RoadRoute, RoutingResult } from './routing-protocol';
import { readOptions, type DirectionOptions } from './settings';
import { colorDirections, RouteColorPalette } from './route-colors';
import { createLineColorResolver } from './browser-colors';
import { RouteLegend } from './route-legend';
import { RouteStatusControl, type RoadPreparationProgress } from './route-status-control';
import { RoadRouteCache } from './route-cache';
import { DetailedRoadMemory } from './detailed-road-memory';
import { prepareBackgroundRoads, buildRoadPreparationStyle, type BackgroundMapFactory } from './background-roads';
import { getBackgroundMapFactory } from './adapter';
import { planRoadPreparation } from './road-preparation-targets';
import { AutoPreparationPolicy, PreparationQueue, autoPreparationKey } from './auto-preparation';
import { TripQueue, planTripConnection, tripConnectionKey, exceedsRoadDistance, roadDistanceLimitReason } from './trip-queue';
import { processTripQueue } from './trip-processor';
import { workloadProfile, DEFAULT_WORKLOAD_SETTINGS, type WorkloadProfile } from './workload-settings';
import type { ResourceSnapshot } from './resource-sampler';
import type { StorageSnapshot } from './storage-usage';
import type { SharedHttpCacheSnapshot } from './shared-http-cache';

interface PreparationServices {
  factory?: (map: MapLike) => BackgroundMapFactory | null;
  run?: typeof prepareBackgroundRoads;
  policy?: AutoPreparationPolicy;
  queue?: PreparationQueue;
  visible?: (map: MapLike) => boolean;
  autoDelayMs?: number;
  tripQueue?: TripQueue;
  workload?: () => WorkloadProfile;
  resources?: () => ResourceSnapshot;
  storage?: () => StorageSnapshot;
  sharedCache?: () => SharedHttpCacheSnapshot;
}

export const RESOURCE_PREFIX = 'obsidian-maps-directions-';
const sessionId = Date.now().toString(36);
let instanceId = 0;

/** A right-facing chevron. Its direction follows the GeoJSON line direction. */
export function createArrowImage(color: string): { width: number; height: number; data: Uint8Array } {
  const width = 64;
  const height = 48;
  const data = new Uint8Array(width * height * 4);
  const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
  const polygon = [[16, 4], [28, 4], [52, 24], [28, 44], [16, 44], [40, 24]];
  const inside = (x: number, y: number): boolean => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let coverage = 0;
      for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) if (inside(x + dx, y + dy)) coverage++;
      if (!coverage) continue;
      const offset = (y * width + x) * 4;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = Math.round(255 * coverage / 4);
    }
  }
  return { width, height, data };
}

/** Adds directions to official Maps without replacing any Maps renderer. */
export class DirectionsOverlay implements OverlayLike {
  private readonly id = `${RESOURCE_PREFIX}${sessionId}-${++instanceId}`;
  private readonly sourceId = `${this.id}-source`;
  private readonly lineId = `${this.id}-lines`;
  private readonly arrowId = `${this.id}-arrows`;
  private readonly dashedId = `${this.id}-dashed`;
  private readonly imageId = `${this.id}-chevron`;
  private map: MapLike | null = null;
  private dataSignature: string | null = null;
  private styleSignature: string | null = null;
  private readonly arrowImages = new Map<string, string>();
  private readonly normalizeColor = createLineColorResolver();
  private readonly routePalette = new RouteColorPalette();
  private readonly automaticPolicy: AutoPreparationPolicy;
  private readonly preparationQueue: PreparationQueue;
  private updating = false;
  private destroyed = false;
  private suspended = false;
  private roadsDirty = true;
  private roads: RoadSnapshot | null = null;
  private routingKey = '';
  private routedData: FeatureCollection | null = null;
  private routingGeneration = 0;
  private routingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingInputKey = '';
  private readonly retainedRoutes = new Map<string, RoadRoute>();
  private routingStatus = 'Straight-line connections.';
  private readonly legend = new RouteLegend();
  private readonly statusControl = new RouteStatusControl();
  private readonly detailedRoads = new DetailedRoadMemory();
  private preparationController: AbortController | null = null;
  private preparationInput = '';
  private preparationProgress: RoadPreparationProgress | undefined;
  private preparationAutomatic = false;
  private preparationAttemptKeys: string[] = [];
  private readonly cancelledAutomatic = new Set<string>();
  private autoTimer: ReturnType<typeof setTimeout> | null = null;
  private autoInput = '';
  private sourceContext: string | null = null;
  private smartInput = '';
  private smartKeys: string[] = [];
  private smartRouteKeys: string[] = [];
  private readonly onMapEvent = (): void => this.update();
  private readonly onRoadsChanged = (...args: unknown[]): void => {
    const event = args[0] as { sourceId?: string } | undefined;
    if (event?.sourceId === this.sourceId) return;
    if (event?.sourceId && this.roads && !this.roads.sources.includes(event.sourceId)) return;
    this.roadsDirty = true;
  };
  private readonly onStyleLoaded = (): void => { this.sourceContext = null; this.detailedRoads.clear(); this.clearRouting(); this.update(); };

  constructor(
    private readonly view: MapsViewLike,
    private readonly onError: (error: unknown) => void,
    private readonly routingClient: RoutingClient = new LocalRoutingClient(),
    private readonly routeCache: RoadRouteCache = new RoadRouteCache(),
    private readonly preparationServices: PreparationServices = {},
  ) {
    this.automaticPolicy = preparationServices.policy ?? new AutoPreparationPolicy();
    this.preparationQueue = preparationServices.queue ?? new PreparationQueue();
  }

  getRoutingStatus(): string { return this.routingStatus; }

  update(): void {
    if (this.destroyed || this.suspended || this.updating) return;
    this.updating = true;
    try {
      const options = readOptions(this.view.config);
      const map = this.view.map;
      if (!options.enabled || !map) {
        this.releaseMap();
        this.routingStatus = 'Directions are disabled or the map is not ready.';
        return;
      }
      if (!options.sequenceProperty) {
        this.releaseMap();
        this.routingStatus = 'No connections: select a Sequence property in Directions.';
        return;
      }
      const directData = buildDirections(this.view.markerManager.markers, options.sequenceProperty, options.groupProperty);
      if (directData.features.length === 0) {
        this.releaseMap();
        this.routingStatus = 'No connections: add at least two markers with numeric Sequence values.';
        return;
      }
      if (this.map !== map) {
        this.releaseMap();
        this.map = map;
        map.on('style.load', this.onStyleLoaded);
        map.on('idle', this.onMapEvent);
        map.on('moveend', this.onRoadsChanged);
        map.on('sourcedata', this.onRoadsChanged);
      }
      if (!map.isStyleLoaded()) return;
      if (this.preparationAutomatic && (!options.autoPrepare || !this.mapVisible(map))) this.cancelPreparation();

      // Color decoration stays outside routing identity: color edits never rerun road search.
      const colored = colorDirections(this.connectionData(map, directData, options.routeMode), this.view.markerManager.markers, { ...options, normalizeColor: this.normalizeColor, palette: this.routePalette });
      const host = map.getContainer?.() ?? null;
      this.legend.update(host, colored, !!options.groupProperty);
      this.statusControl.update(host, colored, options.routeMode === 'local', this.routingStatus, this.roads?.state !== 'unsupported' && this.preparationFactory(map) ? () => { void this.prepareRoadRoutes(false, false); } : null, this.preparationProgress, () => { this.cancelPreparation(true); this.update(); }, options.autoPrepare, this.preparationServices.tripQueue?.snapshot(this.smartKeys), this.preparationServices.resources?.(), this.currentWorkload().label, this.preparationServices.storage?.(), this.preparationServices.sharedCache?.());
      const data: FeatureCollection = { type: 'FeatureCollection', features: colored.features.map(feature => ({
        ...feature, properties: { ...feature.properties, arrowImage: `${this.imageId}-${String(feature.properties.lineColor).slice(1)}` },
      })) };
      const dataSignature = JSON.stringify(data);
      const styleSignature = JSON.stringify([options.arrows, options.color, options.width, options.opacity, options.arrowSize, options.routeMode]);
      const colors = new Set(options.arrows ? data.features.filter(feature => feature.properties.connectionKind !== 'connector').map(feature => String(feature.properties.lineColor)) : []);
      const paletteChanged = colors.size !== this.arrowImages.size || [...colors].some(color => !this.arrowImages.has(color));
      if (styleSignature !== this.styleSignature) {
        this.removeLayer(map, this.arrowId);
        this.removeLayer(map, this.lineId);
        this.removeLayer(map, this.dashedId);
      }
      if (paletteChanged) this.removeLayer(map, this.arrowId);
      for (const [color, id] of this.arrowImages) {
        if (colors.has(color)) continue;
        if (map.hasImage(id)) map.removeImage(id);
        this.arrowImages.delete(color);
      }
      for (const color of colors) {
        const id = `${this.imageId}-${color.slice(1)}`;
        if (!map.hasImage(id)) map.addImage(id, createArrowImage(color), { pixelRatio: 2 });
        this.arrowImages.set(color, id);
      }
      let source = map.getSource(this.sourceId);
      if (!source) {
        map.addSource(this.sourceId, { type: 'geojson', data });
        this.dataSignature = dataSignature;
      } else if (dataSignature !== this.dataSignature) {
        source.setData(data);
        this.dataSignature = dataSignature;
      }
      const beforeId = map.getLayer('marker-pins') ? 'marker-pins' : undefined;
      if (!map.getLayer(this.lineId)) {
        map.addLayer({
          id: this.lineId,
          type: 'line',
          source: this.sourceId,
          filter: ['all', ['!=', ['get', 'connectionKind'], 'fallback'], ['!=', ['get', 'connectionKind'], 'connector']],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'lineColor'], 'line-width': options.width, 'line-opacity': options.opacity },
        }, beforeId);
      }
      if (options.routeMode === 'local' && !map.getLayer(this.dashedId)) {
        map.addLayer({
          id: this.dashedId, type: 'line', source: this.sourceId,
          filter: ['in', ['get', 'connectionKind'], ['literal', ['fallback', 'connector']]],
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': ['get', 'lineColor'], 'line-width': options.width, 'line-opacity': options.opacity * 0.7, 'line-dasharray': [2, 2] },
        }, beforeId);
      }
      if (options.arrows) {
        if (!map.getLayer(this.arrowId)) {
          map.addLayer({
            id: this.arrowId,
            type: 'symbol',
            source: this.sourceId,
            filter: ['!=', ['get', 'connectionKind'], 'connector'],
            layout: {
              'symbol-placement': 'line-center',
              'icon-image': ['get', 'arrowImage'],
              'icon-size': options.arrowSize,
              'icon-keep-upright': false,
              'icon-rotation-alignment': 'map',
              'icon-pitch-alignment': 'map',
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
            paint: { 'icon-opacity': options.opacity },
          }, beforeId);
        }
      }
      this.styleSignature = styleSignature;
      this.scheduleAutomatic(map, directData, options);
    } catch (error) {
      // An incompatible style/view must fail closed until the view is reopened.
      // Otherwise every idle event could retry a failing draw indefinitely.
      this.suspended = true;
      this.releaseMap();
      this.report(error);
    } finally {
      this.updating = false;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseMap();
    this.retainedRoutes.clear();
  }

  private removeLayer(map: MapLike, id: string): void {
    if (map.getLayer(id)) map.removeLayer(id);
  }

  private report(error: unknown): void {
    try { this.onError(error); } catch { /* Reporting must never break official Maps. */ }
  }

  private connectionData(map: MapLike, direct: FeatureCollection, mode: 'straight' | 'local'): FeatureCollection {
    if (mode === 'straight') {
      this.clearRouting();
      this.routingStatus = 'Straight-line connections. Select Follow roads (local) in Directions to try loaded roads.';
      return direct;
    }
    // A route belongs to its endpoints, not to the camera or the current tile set.
    // Cache geometry only; all note properties and access lines use current markers.
    if (this.preparationServices.tripQueue) return this.smartConnections(map, direct);
    const keys = direct.features.map(routeKey);
    for (const key of keys) {
      if (this.retainedRoutes.has(key)) continue;
      const cached = this.routeCache.get(key);
      if (cached) this.retainedRoutes.set(key, cached);
    }
    const currentKeys = new Set(keys);
    for (const key of this.retainedRoutes.keys()) if (!currentKeys.has(key)) this.retainedRoutes.delete(key);
    const missing = keys.flatMap((key, index) => this.retainedRoutes.has(key) ? [] : [index]);
    const inputKey = JSON.stringify(direct);
    if (this.preparationController && this.preparationInput !== inputKey) this.cancelPreparation();
    const retainedData = (): FeatureCollection => applyRoadRoutes(direct, {
      id: 0, routes: keys.map(key => this.retainedRoutes.get(key) ?? null),
      stats: { nodes: 0, edges: 0, truncated: false },
    });
    const retainedCount = keys.filter(key => this.retainedRoutes.has(key)).length;
    if (this.preparationController) {
      this.routedData = retainedData();
      return this.routedData;
    }
    if (!missing.length) {
      if (this.pendingInputKey) this.stopRoutingJob();
      const key = `retained:${inputKey}`;
      if (this.routingKey !== key || !this.routedData) this.routedData = retainedData();
      this.routingKey = key;
      this.routingStatus = `Local roads: ${retainedCount}/${direct.features.length} connections follow roads; ${direct.features.length - retainedCount} use dashed straight fallback. Found paths stay visible at every zoom level. Saved paths remain after reopening.`;
      return this.routedData!;
    }
    // A camera change must not cancel a search already using detailed captured roads.
    if (this.pendingInputKey === inputKey && this.routedData) return this.routedData;
    if (this.roadsDirty || !this.roads) {
      try { this.roads = this.detailedRoads.merge(collectLocalRoads(map)); }
      catch { this.roads = { key: 'unsupported', state: 'unsupported', sources: [], features: [] }; }
      this.roadsDirty = false;
    }
    const roads = this.roads;
    const key = JSON.stringify([roads.key, direct]);
    if (this.routingKey === key && this.routedData) return this.routedData;
    this.stopRoutingJob();
    this.routingKey = key;
    this.routedData = retainedData();
    const reasons = {
      zoom: 'Missing routes are prepared in the background when automatic preparation is enabled.',
      unsupported: 'This background does not expose a supported vector road layer.',
      empty: 'No road lines are loaded here. Background preparation can load more detail.',
      limited: 'This area exceeds the local road data limit. Background preparation searches bounded areas.',
      ready: 'Finding paths on loaded roads…',
    };
    this.routingStatus = `Local roads: ${retainedCount}/${direct.features.length} connections follow roads. ${reasons[roads.state]} Unresolved connections are shown dashed.`;
    if (roads.state !== 'ready') return this.routedData;
    const generation = this.routingGeneration;
    this.pendingInputKey = inputKey;
    this.routingTimer = setTimeout(() => {
      this.routingTimer = null;
      const legs = missing.map(index => {
        const feature = direct.features[index];
        const [from, to] = feature.geometry.coordinates;
        return { from: [normalizeLongitude(from[0]), from[1]] as [number, number], to: [normalizeLongitude(to[0]), to[1]] as [number, number] };
      });
      void this.routingClient.route(roads, legs).then(result => {
        if (this.destroyed || generation !== this.routingGeneration || this.map !== map) return;
        this.pendingInputKey = '';
        missing.forEach((index, routeIndex) => {
          const route = result.routes[routeIndex];
          if (isUsableRoute(route)) {
            this.retainedRoutes.set(keys[index], route);
            this.routeCache.set(keys[index], route);
          }
        });
        this.routedData = retainedData();
        const routed = this.routedData.features.filter(feature => feature.properties.connectionKind === 'road').length;
        this.routingStatus = `Local roads: ${routed}/${direct.features.length} connections follow roads; ${direct.features.length - routed} use dashed straight fallback. ${result.stats.nodes} road nodes. Found paths are saved and stay visible when zooming out.${result.stats.truncated ? ' Road data limit reached.' : ''}`;
        this.update();
      }, () => {
        if (this.destroyed || generation !== this.routingGeneration || this.map !== map) return;
        this.pendingInputKey = '';
        this.routingStatus = `Local roads: ${retainedCount}/${direct.features.length} connections follow roads. Search could not finish; found paths are kept and unresolved connections are shown dashed. Use Retry missing road routes to try again.`;
        this.update();
      });
    }, 150);
    return this.routedData;
  }

  private currentWorkload(): WorkloadProfile {
    return this.preparationServices.workload?.() ?? workloadProfile(DEFAULT_WORKLOAD_SETTINGS);
  }

  workloadChanged(): void {
    this.cancelPreparation();
    this.clearAutomaticTimer();
    this.update();
  }

  private smartConnections(map: MapLike, direct: FeatureCollection): FeatureCollection {
    const ledger = this.preparationServices.tripQueue!;
    const maxDistanceKm = this.currentWorkload().maxDistanceKm;
    const input = JSON.stringify([direct.features.map(feature => feature.geometry.coordinates), this.preparationContext(map), maxDistanceKm]);
    const routeInput = JSON.stringify(direct);
    if (this.preparationController && this.preparationInput !== routeInput) this.cancelPreparation();
    if (this.smartInput !== input) {
      this.smartInput = input;
      const connections = direct.features.map(feature => {
        const [from, to] = feature.geometry.coordinates;
        return { key: tripConnectionKey(from, to, this.preparationContext(map)), from, to, areas: exceedsRoadDistance(from, to, maxDistanceKm) ? [] : planTripConnection(from, to).areas };
      });
      ledger.reconcile(connections);
      this.smartKeys = connections.map(connection => connection.key);
      this.smartRouteKeys = direct.features.map(routeKey);
    }
    const current = new Set(this.smartRouteKeys);
    for (const key of this.retainedRoutes.keys()) if (!current.has(key)) this.retainedRoutes.delete(key);
    const intentionalStraight = new Set<string>();
    this.smartKeys.forEach((key, index) => {
      const routeKey = this.smartRouteKeys[index];
      const [from, to] = direct.features[index].geometry.coordinates;
      if (exceedsRoadDistance(from, to, maxDistanceKm)) {
        if (ledger.status(key)?.state !== 'direct') {
          const saved = this.retainedRoutes.get(routeKey) ?? this.routeCache.get(routeKey);
          if (saved && ledger.status(key)?.state !== 'ready') ledger.finish(key, 'ready', 'Restored saved path.', saved);
        }
        ledger.setDirect(key, roadDistanceLimitReason(from, to, maxDistanceKm));
        this.retainedRoutes.delete(routeKey);
        intentionalStraight.add(routeKey);
        return;
      }
      if (ledger.status(key)?.state === 'direct') ledger.restoreDirect(key, planTripConnection(from, to).areas);
      if (this.retainedRoutes.has(routeKey)) {
        if (ledger.status(key)?.state !== 'ready') ledger.finish(key, 'ready', 'Restored retained path.', this.retainedRoutes.get(routeKey)!);
        return;
      }
      const task = ledger.get(key);
      const route = task?.state === 'ready' ? task.route : this.routeCache.get(routeKey);
      if (route) { this.retainedRoutes.set(routeKey, route); if (task?.state !== 'ready') ledger.finish(key, 'ready', 'Restored saved path.', route); }
    });
    const result = applyRoadRoutes(direct, { id: 0, routes: this.smartRouteKeys.map(key => this.retainedRoutes.get(key) ?? null), stats: { nodes: 0, edges: 0, truncated: false } });
    result.features = result.features.map(feature => feature.properties.connectionKind === 'fallback' && intentionalStraight.has(routeKey(feature)) ? { ...feature, properties: { ...feature.properties, connectionKind: 'direct' } } : feature);
    this.routedData = result;
    const progress = ledger.snapshot(this.smartKeys);
    const paused = this.smartKeys.map(key => ledger.status(key)).find(task => task?.state === 'paused');
    const eligible = progress.eligible ?? progress.total - (progress.direct ?? 0);
    this.routingStatus = `Processed ${progress.processed}/${eligible} eligible connections (${progress.percentComplete}%); ${Math.max(0, eligible - progress.processed)} remaining (${progress.percentRemaining}%). Skipped by distance: ${progress.direct ?? 0}. Found ${progress.ready} road paths; ${progress.noPath} no walking path; ${progress.unavailable} data unavailable; ${progress.paused} paused.${paused?.reason ? ` ${paused.reason}` : ''}`;
    return result;
  }

  private scheduleSmart(map: MapLike, direct: FeatureCollection, options: DirectionOptions): void {
    const ledger = this.preparationServices.tripQueue!;
    if (!options.autoPrepare || options.routeMode !== 'local' || !this.mapVisible(map) || this.preparationController || !this.preparationFactory(map) || !ledger.next(this.smartKeys)) { this.clearAutomaticTimer(); return; }
    const input = JSON.stringify([this.smartKeys, direct.features.map(feature => feature.geometry.coordinates)]);
    if (this.autoTimer && this.autoInput === input) return;
    this.clearAutomaticTimer(); this.autoInput = input;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null; this.autoInput = '';
      if (!this.destroyed && this.map === map) void this.prepareSmartTrip(true, false);
    }, this.preparationServices.autoDelayMs ?? 750);
  }

  private async prepareSmartTrip(automatic: boolean, retryAll: boolean): Promise<void> {
    const ledger = this.preparationServices.tripQueue!;
    if (this.destroyed || this.suspended || this.preparationController) return;
    const options = readOptions(this.view.config), map = this.map;
    if (!map || !options.enabled || options.routeMode !== 'local' || !options.sequenceProperty || automatic && (!options.autoPrepare || !this.mapVisible(map))) return;
    this.clearAutomaticTimer();
    const factory = this.preparationFactory(map);
    if (!factory) return;
    const direct = buildDirections(this.view.markerManager.markers, options.sequenceProperty, options.groupProperty);
    this.smartConnections(map, direct);
    if (!automatic) for (const key of this.smartKeys) {
      const task = ledger.get(key);
      if (task?.state === 'paused') ledger.resume(key);
      else if (retryAll && (task?.state === 'no-path' || task?.state === 'unavailable')) ledger.retry(key);
    }
    if (!ledger.next(this.smartKeys)) { this.update(); return; }
    this.stopRoutingJob();
    const controller = new AbortController();
    this.preparationController = controller;
    this.preparationAutomatic = automatic;
    this.preparationInput = JSON.stringify(direct);
    this.preparationProgress = { running: true, completed: 0, total: 0, message: 'Processing saved trip queue.' };
    this.update();
    try {
      await processTripQueue({
        original: map, keys: [...this.smartKeys], ledger, serial: this.preparationQueue, factory,
        client: this.routingClient, profile: () => this.currentWorkload(), signal: controller.signal,
        run: this.preparationServices.run, visible: () => !automatic || this.mapVisible(map), maxDistanceKm: () => this.currentWorkload().maxDistanceKm,
        onProgress: progress => {
          if (this.destroyed || controller.signal.aborted || this.preparationController !== controller) return;
          this.preparationProgress = { running: true, completed: progress.completed, total: progress.total, message: progress.message };
          this.update();
        },
        onRoute: (key, route) => {
          if (this.destroyed || controller.signal.aborted || this.preparationController !== controller) return;
          this.smartKeys.forEach((candidate, index) => {
            if (candidate !== key) return;
            this.retainedRoutes.set(this.smartRouteKeys[index], route);
            this.routeCache.set(this.smartRouteKeys[index], route);
          });
          this.update();
        },
      });
      if (!controller.signal.aborted) {
        const progress = ledger.snapshot(this.smartKeys);
        this.preparationProgress = { running: false, completed: 0, total: 0, message: progress.paused ? `${progress.paused} connections paused. Open Why dashed lines? for the reason, choose a larger workload if needed, then Resume.` : 'Queue processing finished. Results and progress are saved.' };
      }
    } catch {
      if (!controller.signal.aborted) this.preparationProgress = { running: false, completed: 0, total: 0, message: 'Queue interrupted. Completed connections are saved.' };
    } finally {
      if (this.preparationController === controller) {
        this.preparationController = null; this.preparationInput = ''; this.preparationAutomatic = false;
        this.update();
      } else if (!this.destroyed && this.preparationController === null) {
        // An interrupted processor may have just requeued its unfinished connection.
        this.update();
      }
    }
  }

  private preparationContext(map: MapLike): string {
    if (this.sourceContext === null) this.sourceContext = JSON.stringify(buildRoadPreparationStyle(map.getStyle?.()));
    return this.sourceContext;
  }

  private mapVisible(map: MapLike): boolean {
    if (this.preparationServices.visible) return this.preparationServices.visible(map);
    const host = map.getContainer?.();
    if (!host?.isConnected || typeof host.getBoundingClientRect !== 'function') return false;
    if (host.ownerDocument.visibilityState === 'hidden') return false;
    const bounds = host.getBoundingClientRect();
    const style = host.ownerDocument.defaultView?.getComputedStyle(host);
    return bounds.width > 0 && bounds.height > 0 && style?.visibility !== 'hidden';
  }

  private clearAutomaticTimer(): void {
    if (this.autoTimer) clearTimeout(this.autoTimer);
    this.autoTimer = null;
    this.autoInput = '';
  }

  private scheduleAutomatic(map: MapLike, direct: FeatureCollection, options: DirectionOptions): void {
    if (this.preparationServices.tripQueue) { this.scheduleSmart(map, direct, options); return; }
    if (!options.autoPrepare || options.routeMode !== 'local' || !this.mapVisible(map) || this.preparationController || this.pendingInputKey ||
      this.roads?.state === 'unsupported' || !this.preparationFactory(map)) { this.clearAutomaticTimer(); return; }
    const context = this.preparationContext(map);
    const missing = direct.features.map(routeKey).filter(key => !this.retainedRoutes.has(key));
    const eligible = missing.filter(key => {
      const attempt = autoPreparationKey(key, context);
      return !this.cancelledAutomatic.has(attempt) && this.automaticPolicy.shouldAttempt(attempt);
    });
    if (!eligible.length) { this.clearAutomaticTimer(); return; }
    const input = JSON.stringify([eligible, context]);
    if (this.autoTimer && this.autoInput === input) return;
    this.clearAutomaticTimer();
    this.autoInput = input;
    this.autoTimer = setTimeout(() => {
      this.autoTimer = null; this.autoInput = '';
      if (!this.destroyed && this.map === map) void this.prepareRoadRoutes(true);
    }, this.preparationServices.autoDelayMs ?? 750);
  }

  private preparationFactory(map: MapLike): BackgroundMapFactory | null {
    return this.preparationServices.factory ? this.preparationServices.factory(map) : getBackgroundMapFactory(map);
  }

  private cancelPreparation(suppressAutomatic = false): void {
    const controller = this.preparationController;
    if (!controller) return;
    if (suppressAutomatic && this.preparationServices.tripQueue) for (const key of this.smartKeys) {
      const state = this.preparationServices.tripQueue.status(key)?.state;
      if (state === 'queued' || state === 'preparing') this.preparationServices.tripQueue.pause(key, 'User paused. Resume continues pending connections.');
    }
    if (suppressAutomatic) for (const key of this.preparationAttemptKeys) {
      this.cancelledAutomatic.add(key);
      if (this.cancelledAutomatic.size > 2000) this.cancelledAutomatic.delete(this.cancelledAutomatic.values().next().value!);
    }
    this.preparationController = null;
    this.preparationInput = '';
    this.preparationAutomatic = false;
    this.preparationAttemptKeys = [];
    controller.abort();
    this.stopRoutingJob();
    this.preparationProgress = { ...this.preparationProgress!, running: false, message: 'Preparation stopped. Found paths are saved.' };
  }

  /** Cached paths draw first; automatic and explicit preparation share the same queue. */
  async prepareRoadRoutes(automatic = false, retryAll = true): Promise<void> {
    if (this.preparationServices.tripQueue) return this.prepareSmartTrip(automatic, retryAll);
    if (this.destroyed || this.suspended || this.preparationController) return;
    const options = readOptions(this.view.config), map = this.map;
    if (!map || !options.enabled || options.routeMode !== 'local' || !options.sequenceProperty) return;
    if (automatic && (!options.autoPrepare || !this.mapVisible(map))) return;
    this.clearAutomaticTimer();
    const factory = this.preparationFactory(map);
    if (!factory) return;
    const direct = buildDirections(this.view.markerManager.markers, options.sequenceProperty, options.groupProperty);
    const keys = direct.features.map(routeKey);
    const attemptKeys = keys.map(key => autoPreparationKey(key, this.preparationContext(map)));
    const selected = keys.flatMap((key, index) => !this.retainedRoutes.has(key) &&
      (!automatic || !this.cancelledAutomatic.has(attemptKeys[index]) && this.automaticPolicy.shouldAttempt(attemptKeys[index])) ? [index] : []);
    const missing = selected.map(index => ({ ...direct.features[index], properties: { ...direct.features[index].properties, connectionKind: 'fallback' } }));
    const center = map.getCenter?.();
    let plan = planRoadPreparation({ type: 'FeatureCollection', features: missing }, center ? [center.lng, center.lat] : null);
    if (!plan.centers.length) return;
    this.stopRoutingJob();
    const controller = new AbortController();
    this.preparationController = controller;
    this.preparationAutomatic = automatic;
    this.preparationAttemptKeys = selected.map(index => attemptKeys[index]);
    this.preparationInput = JSON.stringify(direct);
    this.preparationProgress = { running: true, completed: 0, total: plan.centers.length };
    this.routingStatus = 'Preparing detailed roads in the background. The visible map stays in place.';
    this.update();
    const active = (): boolean => !this.destroyed && !controller.signal.aborted && this.preparationController === controller && this.map === map;
    const stopWorker = (): void => this.routingClient.cancel();
    try {
      const result = await this.preparationQueue.run(controller.signal, () => {
        if (automatic && !this.mapVisible(map)) { this.cancelPreparation(); throw new Error('The map is no longer visible.'); }
        for (const index of selected) {
          const cached = this.routeCache.get(keys[index]);
          if (cached) this.retainedRoutes.set(keys[index], cached);
        }
        if (automatic) for (let index = selected.length - 1; index >= 0; index--) {
          const routeIndex = selected[index];
          if (!this.retainedRoutes.has(keys[routeIndex]) && !this.automaticPolicy.shouldAttempt(attemptKeys[routeIndex])) selected.splice(index, 1);
        }
        if (selected.every(index => this.retainedRoutes.has(keys[index]))) {
          this.update();
          return Promise.resolve({ completed: 0, total: 0, ready: 0, timedOut: false });
        }
        plan = planRoadPreparation({ type: 'FeatureCollection', features: selected.filter(index => !this.retainedRoutes.has(keys[index])).map(index => ({ ...direct.features[index], properties: { ...direct.features[index].properties, connectionKind: 'fallback' } })) }, center ? [center.lng, center.lat] : null);
        return (this.preparationServices.run ?? prepareBackgroundRoads)(map, plan.centers, {
        factory, signal: controller.signal,
        onProgress: progress => {
          if (!active()) return;
          this.preparationProgress = { running: true, completed: progress.completed, total: progress.total };
          this.update();
        },
        onSnapshot: async (snapshot, signal) => {
          if (!active()) return false;
          const roads = this.detailedRoads.merge(snapshot);
          if (roads.state !== 'ready') return;
          const indexes = selected.filter(index => !this.retainedRoutes.has(keys[index]));
          if (!indexes.length) return false;
          this.roads = roads;
          signal.addEventListener('abort', stopWorker, { once: true });
          let result: RoutingResult;
          try {
            result = await this.routingClient.route(roads, indexes.map(index => {
              const [from, to] = direct.features[index].geometry.coordinates;
              return { from: [normalizeLongitude(from[0]), from[1]], to: [normalizeLongitude(to[0]), to[1]] };
            }));
          } finally { signal.removeEventListener('abort', stopWorker); }
          if (!active()) return false;
          indexes.forEach((index, routeIndex) => {
            const route = result.routes[routeIndex];
            if (isUsableRoute(route)) { this.retainedRoutes.set(keys[index], route); this.routeCache.set(keys[index], route); }
          });
          this.routingKey = JSON.stringify([roads.key, direct]);
          this.routingStatus = 'Preparing detailed roads in the background. Found paths are saved.';
          this.update();
          return selected.some(index => !this.retainedRoutes.has(keys[index]));
        },
        });
      });
      if (!active()) return;
      const outcome = result.ready > 0 && !result.timedOut && !plan.limited && !plan.skippedLongLegs ? 'no-path' : 'unavailable';
      for (const index of selected) if (!this.retainedRoutes.has(keys[index])) this.automaticPolicy.record(attemptKeys[index], outcome);
      const count = keys.filter(key => this.retainedRoutes.has(key)).length;
      const remaining = direct.features.length - count;
      const noData = result.ready === 0 && selected.some(index => !this.retainedRoutes.has(keys[index]));
      this.preparationProgress = { running: false, completed: result.completed, total: result.total,
        message: `${noData ? 'No detailed road data loaded.' : result.timedOut ? 'Time limit reached.' : 'Preparation complete.'} ${count}/${direct.features.length} follow roads.${remaining ? ` ${remaining} remain dashed.` : ''}${remaining && plan.limited ? ' Area limit reached.' : ''}` };
      this.routingStatus = noData ? 'Detailed roads were unavailable. Check the map background and network connection, then retry. Saved paths remain available.' :
        `Local roads: ${count}/${direct.features.length} connections follow roads. Saved paths remain after reopening.${remaining ? ' Remaining connections could not be matched to a walking path in the available data; missing detail, ferry and flight legs can remain dashed.' : ''}${plan.skippedLongLegs ? ' Long-distance connections received endpoint detail only.' : ''}`;
    } catch (error) {
      if (!active()) return;
      for (const index of selected) if (!this.retainedRoutes.has(keys[index])) this.automaticPolicy.record(attemptKeys[index], 'unavailable');
      this.preparationProgress = { ...this.preparationProgress!, running: false, message: 'Preparation could not finish. Found paths are saved.' };
      this.routingStatus = 'Background road preparation could not finish. Check the map background and network connection. Saved paths remain available.';
      console.warn('Maps Directions: background preparation could not finish', error);
    } finally {
      if (this.preparationController === controller) {
        this.preparationController = null;
        this.preparationInput = '';
        this.preparationAttemptKeys = [];
        this.preparationAutomatic = false;
        this.update();
      }
    }
  }

  private stopRoutingJob(): void {
    this.routingGeneration++;
    if (this.routingTimer) clearTimeout(this.routingTimer);
    this.routingTimer = null;
    this.pendingInputKey = '';
    this.routingClient.cancel();
  }

  private clearRouting(): void {
    this.clearAutomaticTimer();
    this.cancelPreparation();
    this.stopRoutingJob();
    this.routingKey = '';
    this.routedData = null;
    this.roads = null;
    this.roadsDirty = true;
  }

  private releaseMap(): void {
    const map = this.map;
    this.map = null;
    this.dataSignature = null;
    this.styleSignature = null;
    this.sourceContext = null;
    this.smartInput = '';
    this.smartKeys = [];
    this.smartRouteKeys = [];
    this.legend.destroy();
    this.statusControl.destroy();
    this.detailedRoads.clear();
    const imageIds = [...this.arrowImages.values()];
    this.arrowImages.clear();
    this.clearRouting();
    if (!map) return;
    const cleanup = [
      () => map.off('style.load', this.onStyleLoaded),
      () => map.off('idle', this.onMapEvent),
      () => map.off('moveend', this.onRoadsChanged),
      () => map.off('sourcedata', this.onRoadsChanged),
      () => this.removeLayer(map, this.arrowId),
      () => this.removeLayer(map, this.lineId),
      () => this.removeLayer(map, this.dashedId),
      () => { if (map.getSource(this.sourceId)) map.removeSource(this.sourceId); },
      ...imageIds.map(id => () => { if (map.hasImage(id)) map.removeImage(id); }),
    ];
    for (const operation of cleanup) {
      try { operation(); } catch (error) { this.report(error); }
    }
  }
}

function routeKey(feature: FeatureCollection['features'][number]): string {
  return JSON.stringify(feature.geometry.coordinates.map(([lon, lat]) => [normalizeLongitude(lon), lat]));
}

function isUsableRoute(route: RoadRoute | null | undefined): route is RoadRoute {
  return !!route && route.coordinates.length >= 2 && Number.isFinite(route.distance) &&
    route.coordinates.every(point => Number.isFinite(point[0]) && Number.isFinite(point[1]));
}

/** Keep marker positions exact. Small access segments are distinguished from the road path. */
export function applyRoadRoutes(direct: FeatureCollection, result: RoutingResult): FeatureCollection {
  const features: FeatureCollection['features'] = [];
  direct.features.forEach((feature, index) => {
    const route = result.routes[index];
    if (!isUsableRoute(route)) {
      features.push({ ...feature, properties: { ...feature.properties, connectionKind: 'fallback' } });
      return;
    }
    const [from, to] = feature.geometry.coordinates;
    let previous = from[0];
    const coordinates = route.coordinates.map(([lon, lat]): [number, number] => {
      previous += normalizeLongitude(lon - previous);
      return [previous, lat];
    });
    features.push({ ...feature, properties: { ...feature.properties, connectionKind: 'road', distance: route.distance }, geometry: { type: 'LineString', coordinates } });
    for (const [a, b] of [[from, coordinates[0]], [coordinates[coordinates.length - 1], to]]) {
      const dx = normalizeLongitude(a[0] - b[0]) * Math.cos(a[1] * Math.PI / 180);
      const dy = a[1] - b[1];
      if (Math.hypot(dx, dy) * 111195 < 1) continue;
      features.push({ ...feature, properties: { ...feature.properties, connectionKind: 'connector' }, geometry: { type: 'LineString', coordinates: [a, b] } });
    }
  });
  return { type: 'FeatureCollection', features };
}
