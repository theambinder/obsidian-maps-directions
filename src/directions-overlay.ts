import type { FeatureCollection, MapLike, MapsViewLike, OverlayLike } from './contracts';
import { buildDirections, normalizeLongitude } from './geometry';
import { collectLocalRoads, type RoadSnapshot } from './local-roads';
import { LocalRoutingClient, type RoutingClient } from './local-routing-client';
import type { RoadRoute, RoutingResult } from './routing-protocol';
import { readOptions } from './settings';
import { colorDirections } from './route-colors';
import { createLineColorResolver } from './browser-colors';

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
  private readonly onMapEvent = (): void => this.update();
  private readonly onRoadsChanged = (...args: unknown[]): void => {
    const event = args[0] as { sourceId?: string } | undefined;
    if (event?.sourceId === this.sourceId) return;
    if (event?.sourceId && this.roads && !this.roads.sources.includes(event.sourceId)) return;
    this.roadsDirty = true;
  };
  private readonly onStyleLoaded = (): void => { this.clearRouting(); this.update(); };

  constructor(
    private readonly view: MapsViewLike,
    private readonly onError: (error: unknown) => void,
    private readonly routingClient: RoutingClient = new LocalRoutingClient(),
  ) {}

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

      // Color decoration stays outside routing identity: color edits never rerun road search.
      const colored = colorDirections(this.connectionData(map, directData, options.routeMode), this.view.markerManager.markers, { ...options, normalizeColor: this.normalizeColor });
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
    const keys = direct.features.map(routeKey);
    const currentKeys = new Set(keys.slice(0, 200));
    for (const key of this.retainedRoutes.keys()) if (!currentKeys.has(key)) this.retainedRoutes.delete(key);
    const missing = keys.slice(0, 200).flatMap((key, index) => this.retainedRoutes.has(key) ? [] : [index]);
    const inputKey = JSON.stringify(direct);
    const retainedData = (): FeatureCollection => applyRoadRoutes(direct, {
      id: 0, routes: keys.map(key => this.retainedRoutes.get(key) ?? null),
      stats: { nodes: 0, edges: 0, truncated: false },
    });
    const retainedCount = keys.filter(key => this.retainedRoutes.has(key)).length;
    if (!missing.length) {
      if (this.pendingInputKey) this.stopRoutingJob();
      const key = `retained:${inputKey}`;
      if (this.routingKey !== key || !this.routedData) this.routedData = retainedData();
      this.routingKey = key;
      this.routingStatus = `Local roads: ${retainedCount}/${direct.features.length} connections follow roads; ${direct.features.length - retainedCount} use dashed straight fallback. Found paths stay visible at every zoom level while this view is open.`;
      return this.routedData!;
    }
    // A camera change must not cancel a search already using detailed captured roads.
    if (this.pendingInputKey === inputKey && this.routedData) return this.routedData;
    if (this.roadsDirty || !this.roads) {
      try { this.roads = collectLocalRoads(map); }
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
      zoom: 'Zoom in to level 14 or closer to load detailed roads.',
      unsupported: 'This background does not expose a supported vector road layer.',
      empty: 'No road lines are loaded in this area.',
      limited: 'This area has too much road data. Zoom in to a smaller area.',
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
          if (isUsableRoute(route)) this.retainedRoutes.set(keys[index], route);
        });
        this.routedData = retainedData();
        const routed = this.routedData.features.filter(feature => feature.properties.connectionKind === 'road').length;
        this.routingStatus = `Local roads: ${routed}/${direct.features.length} connections follow roads; ${direct.features.length - routed} use dashed straight fallback. ${result.stats.nodes} road nodes. Found paths stay visible when zooming out.${result.stats.truncated ? ' Road data limit reached.' : ''}`;
        this.update();
      }, () => {
        if (this.destroyed || generation !== this.routingGeneration || this.map !== map) return;
        this.pendingInputKey = '';
        this.routingStatus = `Local roads: ${retainedCount}/${direct.features.length} connections follow roads. Search could not finish; found paths are kept and unresolved connections are shown dashed. Try a smaller area.`;
      });
    }, 150);
    return this.routedData;
  }

  private stopRoutingJob(): void {
    this.routingGeneration++;
    if (this.routingTimer) clearTimeout(this.routingTimer);
    this.routingTimer = null;
    this.pendingInputKey = '';
    this.routingClient.cancel();
  }

  private clearRouting(): void {
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
