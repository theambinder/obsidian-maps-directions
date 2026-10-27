import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRoadRoutes, createArrowImage, DirectionsOverlay, RESOURCE_PREFIX } from '../src/directions-overlay';
import type { RoutingClient } from '../src/local-routing-client';
import type { RoadRoute, RoutingResult } from '../src/routing-protocol';
import type { RoadFeature } from '../src/road-graph';
import type { FeatureCollection, GeoJSONSourceLike, MapLike, MapsMarker, MapsViewLike } from '../src/contracts';
import { KEYS } from '../src/settings';
import { RoadRouteCache } from '../src/route-cache';
import type { BackgroundMapFactory, BackgroundRoadPreparationOptions, RoadPreparationResult, prepareBackgroundRoads } from '../src/background-roads';

class FakeMap implements MapLike {
  sources = new Map<string, GeoJSONSourceLike & { data?: FeatureCollection }>([['maps-markers', { setData() {} }]]);
  layers = new Map<string, Record<string, unknown>>([['marker-pins', { id: 'marker-pins' }]]);
  images = new Map<string, { width: number; height: number; data: Uint8Array }>([['maps-pin', { width: 1, height: 1, data: new Uint8Array(4) }]]);
  layerOrder = ['marker-pins'];
  mutations: string[] = [];
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  loaded = true;
  failLayer = false;
  synchronousIdle = false;
  isStyleLoaded(): boolean { return this.loaded; }
  getSource(id: string) { return this.sources.get(id); }
  addSource(id: string, source: { type: 'geojson'; data: FeatureCollection }): void {
    this.mutations.push(`addSource:${id}`);
    const entry = { data: source.data, setData: (data: FeatureCollection) => { entry.data = data; this.mutations.push(`setData:${id}`); } };
    this.sources.set(id, entry);
    if (this.synchronousIdle) this.emit('idle');
  }
  removeSource(id: string): void { this.mutations.push(`removeSource:${id}`); this.sources.delete(id); }
  getLayer(id: string) { return this.layers.get(id); }
  addLayer(layer: Record<string, unknown>, beforeId?: string): void {
    if (this.failLayer) throw Error('Style changed while adding a layer');
    const id = String(layer.id);
    this.mutations.push(`addLayer:${id}`);
    this.layers.set(id, layer);
    const beforeIndex = beforeId ? this.layerOrder.indexOf(beforeId) : -1;
    if (beforeIndex >= 0) this.layerOrder.splice(beforeIndex, 0, id);
    else this.layerOrder.push(id);
  }
  removeLayer(id: string): void {
    this.mutations.push(`removeLayer:${id}`); this.layers.delete(id);
    this.layerOrder = this.layerOrder.filter(value => value !== id);
  }
  hasImage(id: string): boolean { return this.images.has(id); }
  addImage(id: string, image: { width: number; height: number; data: Uint8Array }): void { this.mutations.push(`addImage:${id}`); this.images.set(id, image); }
  removeImage(id: string): void { this.mutations.push(`removeImage:${id}`); this.images.delete(id); }
  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }
  off(event: string, handler: (...args: unknown[]) => void): void { this.listeners.get(event)?.delete(handler); }
  emit(event: string, ...args: unknown[]): void { for (const handler of [...this.listeners.get(event) ?? []]) handler(...args); }
  reloadStyle(): void {
    this.sources = new Map([['maps-markers', { setData() {} }]]);
    this.layers = new Map([['marker-pins', { id: 'marker-pins' }]]);
    this.images = new Map([['maps-pin', { width: 1, height: 1, data: new Uint8Array(4) }]]);
    this.layerOrder = ['marker-pins'];
    this.emit('style.load');
  }
}

function setup(enabled = true, client?: RoutingClient, cache?: RoadRouteCache, preparation?: ConstructorParameters<typeof DirectionsOverlay>[4]) {
  const map = new FakeMap();
  const settings: Record<string, unknown> = { [KEYS.enabled]: enabled, [KEYS.sequence]: 'sequence' };
  const view: MapsViewLike = {
    type: 'map', map,
    config: { get: key => settings[key], getAsPropertyId: key => typeof settings[key] === 'string' ? settings[key] as string : null },
    markerManager: {
      updateMarkers() {},
      markers: [
        { coordinates: [1, 1], entry: { file: { path: 'start.md' }, getValue: () => ({ toString: () => '0' }) } },
        { coordinates: [2, 2], entry: { file: { path: 'end.md' }, getValue: () => ({ toString: () => '1' }) } },
      ],
    },
    register() {},
  };
  const errors: unknown[] = [];
  const overlay = new DirectionsOverlay(view, error => errors.push(error), client, cache, preparation);
  return { map, settings, view, errors, overlay };
}

function assertOriginalResources(map: FakeMap): void {
  assert.ok(map.sources.has('maps-markers'));
  assert.ok(map.layers.has('marker-pins'));
  assert.ok(map.images.has('maps-pin'));
  assert.ok(map.mutations.every(operation => operation.split(':')[1].startsWith(RESOURCE_PREFIX)));
}

test('a disabled overlay makes no map mutations and subscribes to no events', () => {
  const { overlay, map } = setup(false);
  overlay.update();
  overlay.destroy();
  assert.deepEqual(map.mutations, []);
  assert.equal(map.listeners.size, 0);
});

test('clearing Sequence removes lines and stays empty after reopening the view', () => {
  const { overlay, map, view, settings, errors } = setup();
  overlay.update();
  assert.equal(map.sources.size, 2);
  delete settings[KEYS.sequence]; // Bases removes a cleared property key from the saved view.
  overlay.update();
  assert.equal(map.sources.size, 1);
  assert.equal(map.layers.size, 1);
  assert.match(overlay.getRoutingStatus(), /select a Sequence property/);
  overlay.destroy();
  const reopened = new DirectionsOverlay(view, error => errors.push(error));
  reopened.update();
  assert.equal(map.sources.size, 1);
  assert.equal(map.layers.size, 1);
  assertOriginalResources(map);
  assert.deepEqual(errors, []);
  reopened.destroy();
});

test('adds only its own connection layers below original Maps marker pins', () => {
  const { overlay, map, errors } = setup();
  overlay.update();
  assert.equal(map.sources.size, 2);
  assert.equal(map.layers.size, 3);
  assert.equal(map.images.size, 2);
  assert.equal(map.layerOrder.at(-1), 'marker-pins');
  const arrow = [...map.layers.values()].find(layer => layer.type === 'symbol')!;
  assert.equal((arrow.layout as Record<string, unknown>)['symbol-placement'], 'line-center');
  assert.equal((arrow.layout as Record<string, unknown>)['icon-keep-upright'], false);
  assert.equal((arrow.layout as Record<string, unknown>)['icon-rotation-alignment'], 'map');
  assert.equal((arrow.layout as Record<string, unknown>)['icon-pitch-alignment'], 'map');
  assertOriginalResources(map);
  assert.deepEqual(errors, []);
});

test('style reload restores directions and repeated idle events cause no mutations', () => {
  const { overlay, map } = setup();
  map.synchronousIdle = true;
  overlay.update();
  const afterInitial = map.mutations.length;
  for (let i = 0; i < 10; i++) map.emit('idle');
  assert.equal(map.mutations.length, afterInitial);
  map.reloadStyle();
  assert.equal(map.sources.size, 2);
  assert.equal(map.layers.size, 3);
  assert.equal(map.images.size, 2);
  const afterReload = map.mutations.length;
  map.emit('idle');
  assert.equal(map.mutations.length, afterReload);
  assertOriginalResources(map);
});

test('waits until the official map style is ready', () => {
  const { overlay, map } = setup();
  map.loaded = false;
  overlay.update();
  assert.deepEqual(map.mutations, []);
  map.loaded = true;
  map.emit('style.load');
  assert.equal(map.layers.size, 3);
});

test('marker changes update source data without replacing layers or original markers', () => {
  const { overlay, map, view } = setup();
  overlay.update();
  map.mutations.length = 0;
  view.markerManager.markers[1].coordinates = [4, 5];
  overlay.update();
  assert.equal(map.mutations.length, 1);
  assert.ok(map.mutations[0].startsWith('setData:'));
  const data = [...map.sources.values()].find(source => source.data)?.data;
  assert.deepEqual(data?.features[0].geometry.coordinates, [[1, 1], [5, 4]]);
});

test('disable and unload remove only owned resources and all event listeners', () => {
  const { overlay, map, settings } = setup();
  overlay.update();
  settings[KEYS.enabled] = false;
  overlay.update();
  assert.equal(map.sources.size, 1);
  assert.equal(map.layers.size, 1);
  assert.equal(map.images.size, 1);
  assert.ok([...map.listeners.values()].every(handlers => handlers.size === 0));
  assertOriginalResources(map);
  const count = map.mutations.length;
  overlay.destroy();
  overlay.destroy();
  map.emit('idle');
  assert.equal(map.mutations.length, count);
});

test('switching map instances removes resources and listeners from the old map', () => {
  const { overlay, map, view } = setup();
  overlay.update();
  const nextMap = new FakeMap();
  view.map = nextMap;
  overlay.update();
  assert.equal(map.layers.size, 1);
  assert.ok([...map.listeners.values()].every(handlers => handlers.size === 0));
  assert.equal(nextMap.layers.size, 3);
  overlay.destroy();
  assert.equal(nextMap.layers.size, 1);
  assertOriginalResources(map);
  assertOriginalResources(nextMap);
});

test('changing arrow visibility and color replaces only owned drawing resources', () => {
  const { overlay, map, settings } = setup();
  overlay.update();
  settings[KEYS.arrows] = false;
  overlay.update();
  assert.equal(map.layers.size, 2);
  assert.equal(map.images.size, 1);
  settings[KEYS.color] = '#2583e8';
  settings[KEYS.arrows] = true;
  overlay.update();
  const image = [...map.images].find(([id]) => id.startsWith(RESOURCE_PREFIX))![1];
  const opaquePixel = [...image.data].findIndex((value, index) => index % 4 === 3 && value === 255) - 3;
  assert.deepEqual([...image.data.slice(opaquePixel, opaquePixel + 3)], [37, 131, 232]);
  assertOriginalResources(map);
});

test('a drawing failure suspends the overlay without repeated errors or official Maps changes', () => {
  const { overlay, map, errors } = setup();
  map.failLayer = true;
  assert.doesNotThrow(() => overlay.update());
  assert.equal(errors.length, 1);
  assert.equal(map.sources.size, 1);
  assert.equal(map.layers.size, 1);
  assertOriginalResources(map);
  map.failLayer = false;
  const mutationsAfterFailure = map.mutations.length;
  overlay.update();
  map.emit('idle');
  map.emit('style.load');
  assert.equal(map.mutations.length, mutationsAfterFailure);
  assert.equal(errors.length, 1);
  assert.equal(map.layers.size, 1);
  overlay.destroy();
});

test('the arrow bitmap is colored, transparent, and points to the right', () => {
  const image = createArrowImage('#2583e8');
  const alpha = (x: number, y: number) => image.data[(y * image.width + x) * 4 + 3];
  assert.equal(image.data.length, image.width * image.height * 4);
  assert.equal(alpha(0, 0), 0);
  assert.ok(alpha(50, 24) > 0);
  assert.equal(alpha(17, 24), 0);
  assert.ok(alpha(20, 6) > 0);
  assert.ok(alpha(20, 41) > 0);
});

test('local mode without detailed vector roads draws a dashed fallback and never starts a worker', () => {
  let calls = 0;
  const { overlay, map, settings } = setup(true, { route: async () => { calls++; throw Error(); }, cancel() {} });
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  assert.equal(calls, 0);
  assert.match(overlay.getRoutingStatus(), /supported vector/);
  assert.ok([...map.layers.values()].some(layer => (layer.paint as Record<string, unknown> | undefined)?.['line-dasharray']));
  const data = [...map.sources.values()].find(source => source.data)?.data;
  assert.equal(data?.features[0].properties.connectionKind, 'fallback');
  assertOriginalResources(map);
  overlay.destroy();
});

test('road paths keep their bends and distinguish pin access segments from missing routes', () => {
  const direct: FeatureCollection = { type: 'FeatureCollection', features: [
    { type: 'Feature', properties: { from: 'a', to: 'b' }, geometry: { type: 'LineString', coordinates: [[139, 35], [139.002, 35.002]] } },
    { type: 'Feature', properties: { from: 'b', to: 'c' }, geometry: { type: 'LineString', coordinates: [[139.002, 35.002], [140, 36]] } },
  ] };
  const result = applyRoadRoutes(direct, { id: 1, routes: [{ coordinates: [[139.0001, 35], [139.001, 35], [139.001, 35.002], [139.002, 35.002]], distance: 400 }, null], stats: { nodes: 4, edges: 3, truncated: false } });
  assert.deepEqual(result.features.map(feature => feature.properties.connectionKind), ['road', 'connector', 'fallback']);
  assert.equal(result.features[0].geometry.coordinates.length, 4);
  assert.deepEqual(result.features[1].geometry.coordinates[0], direct.features[0].geometry.coordinates[0]);
  assert.equal(result.features[2].properties.to, 'c');
});

test('local search deduplicates idle events, ignores stale results after disabling, and preserves Maps', async () => {
  let resolveJob!: (result: RoutingResult) => void;
  let calls = 0;
  const { overlay, map, settings } = setup(true, { route: () => { calls++; return new Promise(resolve => { resolveJob = resolve; }); }, cancel() {} });
  Object.assign(map, {
    getZoom: () => 15,
    getStyle: () => ({ sources: { osm: { type: 'vector' } }, layers: [{ source: 'osm', 'source-layer': 'transportation' }] }),
    querySourceFeatures: () => [{ geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] }, properties: { class: 'minor' } }],
  });
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  for (let i = 0; i < 10; i++) map.emit('idle');
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(calls, 1);
  settings[KEYS.enabled] = false;
  overlay.update();
  const afterDisable = map.mutations.length;
  resolveJob({ id: 1, routes: [{ coordinates: [[1, 1], [1.5, 1], [2, 2]], distance: 100 }], stats: { nodes: 3, edges: 2, truncated: false } });
  await Promise.resolve();
  assert.equal(map.mutations.length, afterDisable);
  assert.equal(map.sources.size, 1);
  assert.ok([...map.listeners.values()].every(handlers => handlers.size === 0));
  assertOriginalResources(map);
});

test('local road results are drawn once and style changes do not repeat the search', async () => {
  let calls = 0;
  const { overlay, map, settings } = setup(true, { route: async () => {
    calls++; return { id: calls, routes: [{ coordinates: [[1, 1], [1.5, 1], [2, 2]], distance: 100 }], stats: { nodes: 3, edges: 2, truncated: false } };
  }, cancel() {} });
  Object.assign(map, {
    getZoom: () => 15,
    getStyle: () => ({ sources: { osm: { type: 'vector' } }, layers: [{ source: 'osm', 'source-layer': 'transportation' }] }),
    querySourceFeatures: () => [{ geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2]] }, properties: { class: 'minor' } }],
  });
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await new Promise(resolve => setTimeout(resolve, 180));
  const data = [...map.sources.values()].find(source => source.data)?.data;
  assert.equal(data?.features[0].properties.connectionKind, 'road');
  assert.match(overlay.getRoutingStatus(), /1\/1 connections follow roads/);
  settings[KEYS.color] = '#2583e8';
  overlay.update();
  const mutations = map.mutations.length;
  for (let i = 0; i < 10; i++) map.emit('idle');
  assert.equal(map.mutations.length, mutations);
  assert.equal(calls, 1);
  assertOriginalResources(map);
  overlay.destroy();
});

class DeferredRoutingClient implements RoutingClient {
  calls: Array<{
    snapshot: Parameters<RoutingClient['route']>[0];
    legs: Parameters<RoutingClient['route']>[1];
    resolve: (result: RoutingResult) => void;
    reject: (error: Error) => void;
  }> = [];
  cancellations = 0;
  route(snapshot: Parameters<RoutingClient['route']>[0], legs: Parameters<RoutingClient['route']>[1]): Promise<RoutingResult> {
    return new Promise((resolve, reject) => { this.calls.push({ snapshot, legs, resolve, reject }); });
  }
  cancel(): void { this.cancellations++; }
  finish(index: number, routes: Array<RoadRoute | null>): void {
    this.calls[index].resolve({ id: index + 1, routes, stats: { nodes: 10, edges: 9, truncated: false } });
  }
}

function attachRoads(map: FakeMap) {
  const state = {
    zoom: 15, queries: 0,
    roads: [{ geometry: { type: 'LineString', coordinates: [[1, 1], [2, 2], [3, 3], [4, 4]] }, properties: { class: 'minor' } }] as RoadFeature[],
  };
  Object.assign(map, {
    getZoom: () => state.zoom,
    getStyle: () => ({ sources: { osm: { type: 'vector' } }, layers: [{ source: 'osm', 'source-layer': 'transportation' }] }),
    querySourceFeatures: () => { state.queries++; return state.roads; },
  });
  return state;
}

function directionData(map: FakeMap): FeatureCollection {
  const source = [...map.sources.values()].find(source => source.data);
  assert.ok(source?.data);
  return source.data;
}

function mainConnections(map: FakeMap) {
  return directionData(map).features.filter(feature => feature.properties.connectionKind !== 'connector');
}

function extraMarker(name: string, coordinate: number, sequence: number): MapsMarker {
  return { coordinates: [coordinate, coordinate], entry: { file: { path: name }, getValue: () => ({ toString: () => String(sequence) }) } };
}

const roadAB: RoadRoute = { coordinates: [[1, 1], [1.5, 1], [2, 2]], distance: 100 };
const roadBC: RoadRoute = { coordinates: [[2, 2], [2.5, 2], [3, 3]], distance: 110 };
const waitForRouting = () => new Promise(resolve => setTimeout(resolve, 180));
const flushRouting = async () => { await Promise.resolve(); await Promise.resolve(); };

class OverlayTestDocument {
  createElement(tag: string): OverlayTestElement { return new OverlayTestElement(tag, this); }
}
class OverlayTestElement {
  children: OverlayTestElement[] = [];
  parent: OverlayTestElement | null = null;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<string, (event: { stopPropagation(): void }) => void>();
  className = ''; textContent = ''; title = ''; hidden = false; disabled = false; open = false; type = '';
  constructor(readonly tag: string, readonly ownerDocument: OverlayTestDocument) {}
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  append(...children: OverlayTestElement[]): void {
    for (const child of children) { child.parent = this; this.children.push(child); }
  }
  replaceChildren(...children: OverlayTestElement[]): void {
    this.children.forEach(child => { child.parent = null; }); this.children = []; this.append(...children);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
  }
  addEventListener(name: string, listener: (event: { stopPropagation(): void }) => void): void { this.listeners.set(name, listener); }
  click(): void { this.listeners.get('click')?.({ stopPropagation() {} }); }
}

class DeferredBackgroundPreparation {
  readonly factory: BackgroundMapFactory = () => { throw Error('The fake runner must not construct a map.'); };
  readonly calls: Array<{
    original: Parameters<typeof prepareBackgroundRoads>[0];
    centers: Parameters<typeof prepareBackgroundRoads>[1];
    options: BackgroundRoadPreparationOptions;
    resolve: (result: RoadPreparationResult) => void;
  }> = [];
  readonly run: typeof prepareBackgroundRoads = (original, centers, options) => new Promise(resolve => {
    this.calls.push({ original, centers, options, resolve });
  });
  readonly services = { factory: () => this.factory, run: this.run };
  snapshot(index: number, features: RoadFeature[]): Promise<unknown> {
    const call = this.calls[index];
    return Promise.resolve(call.options.onSnapshot({ key: `prepared-${index}`, features, sources: ['osm'], state: 'ready' }, call.options.signal!));
  }
  progress(index: number, completed: number): void {
    const call = this.calls[index];
    call.options.onProgress?.({ completed, total: call.centers.length, ready: completed });
  }
  finish(index: number, overrides: Partial<RoadPreparationResult> = {}): void {
    const call = this.calls[index];
    call.resolve({ completed: call.centers.length, total: call.centers.length, ready: call.centers.length, timedOut: false, ...overrides });
  }
}

function preparationSetup() {
  const background = new DeferredBackgroundPreparation();
  const client = new DeferredRoutingClient();
  const cache = new RoadRouteCache();
  const subject = setup(true, client, cache, background.services);
  const roads = attachRoads(subject.map);
  roads.zoom = 6; // The current overview does not expose detailed road geometry.
  const host = new OverlayTestDocument().createElement('div');
  const cameraMoves: unknown[] = [];
  Object.assign(subject.map, {
    getContainer: () => host as unknown as HTMLElement,
    getCenter: () => ({ lng: 1, lat: 1 }),
    jumpTo: (...args: unknown[]) => cameraMoves.push(args),
    flyTo: (...args: unknown[]) => cameraMoves.push(args),
    fitBounds: (...args: unknown[]) => cameraMoves.push(args),
  });
  subject.settings[KEYS.routeMode] = 'local';
  return { ...subject, background, client, cache, roads, host, cameraMoves };
}

function preparationControl(host: OverlayTestElement) {
  const root = host.children.find(child => child.className === 'obsidian-maps-directions-route-status');
  assert.ok(root, 'Expected the on-map road preparation control.');
  return { root, button: root.children[0].children[1], count: root.children[0].children[0], progress: root.children[1] };
}

test('background road preparation requires the explicit map action and never moves the visible camera', async () => {
  const { overlay, map, background, client, host, cameraMoves, roads, errors } = preparationSetup();
  overlay.update();
  for (let index = 0; index < 5; index++) { map.emit('moveend'); map.emit('idle'); }
  await waitForRouting();
  assert.equal(background.calls.length, 0);
  assert.equal(client.calls.length, 0);
  const control = preparationControl(host);
  assert.equal(control.button.textContent, 'Prepare road routes');
  control.button.click();
  assert.equal(background.calls.length, 1);
  assert.equal(background.calls[0].original, map);
  assert.ok(background.calls[0].centers.length > 0 && background.calls[0].centers.length <= 64);
  assert.equal(control.button.textContent, 'Cancel');
  background.progress(0, 1);
  assert.equal(control.progress.textContent, `Preparing roads: 1/${background.calls[0].centers.length} areas`);
  background.finish(0);
  await flushRouting();
  assert.equal(control.button.textContent, 'Prepare road routes');
  assert.match(control.progress.textContent, /Preparation complete/);
  assert.deepEqual(cameraMoves, []);
  assert.equal(roads.zoom, 6);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
  assert.equal(host.children.length, 0);
});

test('prepared road snapshots find paths, refresh the live map, and persist the geometry', async () => {
  const { overlay, map, background, client, cache, host, cameraMoves, errors } = preparationSetup();
  overlay.update();
  const preparation = overlay.prepareRoadRoutes();
  const snapshot = background.snapshot(0, [{ geometry: { type: 'LineString', coordinates: roadAB.coordinates }, properties: { class: 'minor' } }]);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].legs, [{ from: [1, 1], to: [2, 2] }]);
  client.finish(0, [roadAB]);
  assert.equal(await snapshot, false); // All requested connections are found; stop loading areas.
  assert.deepEqual(mainConnections(map)[0].geometry.coordinates, roadAB.coordinates);
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'road');
  assert.equal(cache.serialize().routes.length, 1);
  assert.equal(preparationControl(host).count.textContent, 'Road routes: 1/1');
  background.finish(0);
  await preparation;
  assert.equal(preparationControl(host).button.hidden, true);
  assert.match(preparationControl(host).progress.textContent, /1\/1 follow roads/);
  assert.deepEqual(cameraMoves, []);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
});

test('preparation without any loaded road areas explains unavailable data instead of claiming disconnected paths', async () => {
  const { overlay, map, background, client, cache, host, errors } = preparationSetup();
  overlay.update();
  const preparation = overlay.prepareRoadRoutes();
  background.finish(0, { ready: 0 });
  await preparation;
  const control = preparationControl(host);
  const diagnostic = control.root.children[2].children[2].textContent;
  assert.match(control.progress.textContent, /no detailed road|unavailable/i);
  assert.match(diagnostic, /unavailable|no detailed road/i);
  assert.doesNotMatch(diagnostic, /no connected walking path/i);
  assert.equal(control.button.textContent, 'Prepare road routes');
  assert.equal(control.button.hidden, false);
  assert.equal(client.calls.length, 0);
  assert.equal(cache.serialize().routes.length, 0);
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'fallback');
  assert.deepEqual(errors, []);
  overlay.destroy();
});

test('Cancel aborts asynchronous preparation and late worker results cannot save a stale path', async () => {
  const { overlay, map, background, client, cache, host, errors } = preparationSetup();
  overlay.update();
  const preparation = overlay.prepareRoadRoutes();
  background.progress(0, 1);
  const snapshot = background.snapshot(0, [{ geometry: { type: 'LineString', coordinates: roadAB.coordinates }, properties: { class: 'minor' } }]);
  const signal = background.calls[0].options.signal!;
  const cancellations = client.cancellations;
  const control = preparationControl(host);
  assert.equal(control.button.textContent, 'Cancel');
  control.button.click();
  assert.equal(signal.aborted, true);
  assert.ok(client.cancellations > cancellations);
  assert.match(control.progress.textContent, /Preparation stopped/);
  client.finish(0, [roadAB]);
  assert.equal(await snapshot, false);
  background.progress(0, 2); // A late notification must not resurrect the progress UI.
  background.finish(0);
  await preparation;
  assert.equal(cache.serialize().routes.length, 0);
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'fallback');
  assert.equal(control.button.textContent, 'Prepare road routes');
  assert.match(control.progress.textContent, /Preparation stopped/);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
});

for (const scenario of ['marker edit', 'disable', 'style reload', 'unload'] as const) {
  test(`${scenario} aborts pending background preparation and rejects its later snapshots and paths`, async () => {
    const { overlay, map, view, settings, background, client, cache, host, errors } = preparationSetup();
    overlay.update();
    const preparation = overlay.prepareRoadRoutes();
    const snapshot = background.snapshot(0, [{ geometry: { type: 'LineString', coordinates: roadAB.coordinates }, properties: { class: 'minor' } }]);
    const signal = background.calls[0].options.signal!;
    if (scenario === 'marker edit') { view.markerManager.markers[1].coordinates = [3, 3]; overlay.update(); }
    else if (scenario === 'disable') { settings[KEYS.enabled] = false; overlay.update(); }
    else if (scenario === 'style reload') map.reloadStyle();
    else overlay.destroy();
    assert.equal(signal.aborted, true);
    client.finish(0, [roadAB]);
    assert.equal(await snapshot, false);
    const calls = client.calls.length;
    assert.equal(await background.snapshot(0, [{ geometry: { type: 'LineString', coordinates: roadAB.coordinates }, properties: { class: 'minor' } }]), false);
    assert.equal(client.calls.length, calls);
    background.progress(0, 1);
    background.finish(0);
    await preparation;
    assert.equal(cache.serialize().routes.length, 0);
    if (scenario === 'marker edit' || scenario === 'style reload') assert.equal(mainConnections(map)[0].properties.connectionKind, 'fallback');
    else { assert.equal(map.sources.size, 1); assert.equal(host.children.length, 0); }
    assert.deepEqual(errors, []);
    assertOriginalResources(map);
    overlay.destroy();
  });
}

test('color changes keep background preparation alive and new paths use the current color', async () => {
  const { overlay, map, settings, background, client, cache, errors } = preparationSetup();
  overlay.update();
  const preparation = overlay.prepareRoadRoutes();
  const snapshot = background.snapshot(0, [{ geometry: { type: 'LineString', coordinates: roadAB.coordinates }, properties: { class: 'minor' } }]);
  settings[KEYS.color] = '#2583e8';
  settings[KEYS.width] = 5;
  overlay.update();
  assert.equal(background.calls[0].options.signal!.aborted, false);
  assert.equal(background.calls.length, 1);
  assert.equal(client.calls.length, 1);
  client.finish(0, [roadAB]);
  assert.equal(await snapshot, false);
  assert.equal(mainConnections(map)[0].properties.lineColor, '#2583e8');
  assertMatchingArrowImages(map);
  background.finish(0);
  await preparation;
  assert.equal(cache.serialize().routes.length, 1);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
});

test('found road geometry survives zooming out and panning into areas without detailed roads', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings } = setup(true, client);
  const roads = attachRoads(map);
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await waitForRouting();
  client.finish(0, [roadAB]);
  await flushRouting();
  const found = structuredClone(directionData(map));
  const queries = roads.queries;
  for (const zoom of [13, 6]) {
    roads.zoom = zoom;
    map.emit('moveend');
    map.emit('idle');
    assert.deepEqual(directionData(map), found);
  }
  roads.zoom = 15;
  roads.roads = [];
  map.emit('moveend');
  map.emit('sourcedata', { sourceId: 'osm' });
  map.emit('idle');
  assert.deepEqual(directionData(map), found);
  assert.equal(client.calls.length, 1);
  assert.equal(roads.queries, queries);
  assert.match(overlay.getRoutingStatus(), /every zoom level/);
  assertOriginalResources(map);
  overlay.destroy();
});

test('style reload and map recreation restore retained paths without needing loaded road sources', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, view, errors } = setup(true, client);
  const roads = attachRoads(map);
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await waitForRouting();
  client.finish(0, [roadAB]);
  await flushRouting();
  const found = structuredClone(directionData(map));
  roads.zoom = 6;
  map.reloadStyle();
  assert.deepEqual(directionData(map), found);
  const replacement = new FakeMap(); // No querySourceFeatures or road source is available.
  view.map = replacement;
  overlay.update();
  assert.deepEqual(directionData(replacement), found);
  assert.equal(client.calls.length, 1);
  assert.equal(map.sources.size, 1);
  assert.ok([...map.listeners.values()].every(handlers => handlers.size === 0));
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  assertOriginalResources(replacement);
  overlay.destroy();
});

test('searching only missing legs preserves found paths and maps subset results to the correct connections', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, view } = setup(true, client);
  attachRoads(map);
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await waitForRouting();
  client.finish(0, [roadAB]);
  await flushRouting();
  view.markerManager.markers.push(extraMarker('third.md', 3, 2));
  overlay.update();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['road', 'fallback']);
  await waitForRouting();
  assert.deepEqual(client.calls[1].legs, [{ from: [2, 2], to: [3, 3] }]);
  client.finish(1, [roadBC]);
  await flushRouting();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.to), ['end.md', 'third.md']);
  assert.deepEqual(mainConnections(map).map(feature => feature.geometry.coordinates), [roadAB.coordinates, roadBC.coordinates]);

  view.markerManager.markers.push(extraMarker('fourth.md', 4, 3));
  overlay.update();
  await waitForRouting();
  assert.deepEqual(client.calls[2].legs, [{ from: [3, 3], to: [4, 4] }]);
  client.calls[2].reject(new Error('Search failed'));
  await flushRouting();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['road', 'road', 'fallback']);
  view.markerManager.markers[3].coordinates = [4.5, 4.5];
  overlay.update();
  await waitForRouting();
  client.finish(3, [null]);
  await flushRouting();
  assert.deepEqual(mainConnections(map).slice(0, 2).map(feature => feature.geometry.coordinates), [roadAB.coordinates, roadBC.coordinates]);
  assert.equal(mainConnections(map)[2].properties.connectionKind, 'fallback');
  assertOriginalResources(map);
  overlay.destroy();
});

test('moving an endpoint invalidates only its leg and reversing Sequence never reuses a forward path', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, view } = setup(true, client);
  const roads = attachRoads(map);
  view.markerManager.markers.push(extraMarker('third.md', 3, 2));
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await waitForRouting();
  client.finish(0, [roadAB, roadBC]);
  await flushRouting();
  roads.zoom = 6;
  map.emit('moveend');
  view.markerManager.markers[0].coordinates = [0.5, 0.5];
  overlay.update();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['fallback', 'road']);
  assert.deepEqual(mainConnections(map)[0].geometry.coordinates[0], [0.5, 0.5]);
  assert.deepEqual(mainConnections(map)[1].geometry.coordinates, roadBC.coordinates);
  view.markerManager.markers.forEach((marker, index) => {
    marker.entry.getValue = () => ({ toString: () => String(2 - index) });
  });
  overlay.update();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['fallback', 'fallback']);
  assert.equal(mainConnections(map)[0].properties.from, 'third.md');
  assert.equal(mainConnections(map)[0].properties.to, 'end.md');
  assert.equal(client.calls.length, 1);
  assertOriginalResources(map);
  overlay.destroy();
});

test('zooming out while a road search is pending does not cancel its captured detailed roads', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings } = setup(true, client);
  const roads = attachRoads(map);
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  const cancellations = client.cancellations;
  for (const zoom of [13, 6]) {
    roads.zoom = zoom;
    map.emit('moveend');
    map.emit('idle');
  }
  assert.equal(client.cancellations, cancellations);
  await waitForRouting();
  assert.equal(client.calls.length, 1);
  client.finish(0, [roadAB]);
  await flushRouting();
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'road');
  assert.deepEqual(mainConnections(map)[0].geometry.coordinates, roadAB.coordinates);
  assert.equal(roads.queries, 1);
  overlay.destroy();
});

test('a late result for moved endpoints cannot populate retained paths for the former connection', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, view } = setup(true, client);
  const roads = attachRoads(map);
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await waitForRouting();
  roads.zoom = 6;
  map.emit('moveend');
  view.markerManager.markers[1].coordinates = [3, 3];
  overlay.update();
  client.finish(0, [roadAB]);
  await flushRouting();
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'fallback');
  assert.deepEqual(mainConnections(map)[0].geometry.coordinates[1], [3, 3]);
  view.markerManager.markers[1].coordinates = [2, 2];
  overlay.update();
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'fallback');
  assert.equal(client.calls.length, 1);
  assertOriginalResources(map);
  overlay.destroy();
});

function groupedMarker(path: string, coordinate: number, sequence: number, route: string, color: () => string = () => ''): MapsMarker {
  return {
    coordinates: [coordinate, coordinate],
    entry: {
      file: { path },
      getValue: property => {
        const value = property === 'sequence' ? String(sequence) : property === 'route' ? route : property === 'routeColor' ? color() : null;
        return value === null ? null : { toString: () => value };
      },
    },
  };
}

function groupPairs(view: MapsViewLike, colorA: () => string = () => '', colorB: () => string = () => ''): void {
  view.markerManager.markers = [
    groupedMarker('a1.md', 1, 1, 'Day 1', colorA), groupedMarker('a2.md', 2, 2, 'Day 1', colorA),
    groupedMarker('b1.md', 3, 1, 'Day 2', colorB), groupedMarker('b2.md', 4, 2, 'Day 2', colorB),
  ];
}

function assertMatchingArrowImages(map: FakeMap): void {
  for (const feature of mainConnections(map)) {
    const color = String(feature.properties.lineColor);
    const image = map.images.get(String(feature.properties.arrowImage));
    assert.ok(image, `Missing arrow image for ${color}`);
    const opaquePixel = [...image.data].findIndex((value, index) => index % 4 === 3 && value === 255) - 3;
    assert.ok(opaquePixel >= 0);
    const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
    assert.deepEqual([...image.data.slice(opaquePixel, opaquePixel + 3)], channels);
  }
}

test('a new map view restores saved geometry without detailed roads or a worker and uses current styling', async () => {
  let changes = 0;
  const cache = new RoadRouteCache(undefined, () => changes++);
  const firstClient = new DeferredRoutingClient();
  const first = setup(true, firstClient, cache);
  attachRoads(first.map);
  first.settings[KEYS.routeMode] = 'local';
  first.overlay.update();
  await waitForRouting();
  firstClient.finish(0, [roadAB]);
  await flushRouting();
  assert.equal(changes, 1);
  assert.equal(cache.serialize().routes.length, 1);
  first.overlay.destroy();

  const restored = new RoadRouteCache(JSON.parse(JSON.stringify(cache.serialize())));
  const nextClient = new DeferredRoutingClient();
  const next = setup(true, nextClient, restored); // No road query or style API is exposed.
  next.settings[KEYS.routeMode] = 'local';
  next.settings[KEYS.color] = '#2583e8';
  next.overlay.update();
  assert.equal(mainConnections(next.map)[0].properties.connectionKind, 'road');
  assert.deepEqual(mainConnections(next.map)[0].geometry.coordinates, roadAB.coordinates);
  assert.equal(mainConnections(next.map)[0].properties.lineColor, '#2583e8');
  assertMatchingArrowImages(next.map);
  assert.match(next.overlay.getRoutingStatus(), /saved paths.*reopen/i);
  await waitForRouting();
  assert.equal(nextClient.calls.length, 0);
  assert.deepEqual(next.errors, []);
  assertOriginalResources(first.map);
  assertOriginalResources(next.map);
  next.overlay.destroy();
});

test('saved paths match ordered endpoints exactly after edits and never attach to a reversed connection', async () => {
  const cache = new RoadRouteCache();
  cache.set(JSON.stringify([[1, 1], [2, 2]]), roadAB);
  cache.set(JSON.stringify([[2, 2], [3, 3]]), roadBC);
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, view, errors } = setup(true, client, cache);
  view.markerManager.markers.push(extraMarker('third.md', 3, 2));
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['road', 'road']);

  view.markerManager.markers[0].coordinates = [0.5, 0.5];
  overlay.update();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['fallback', 'road']);
  assert.deepEqual(mainConnections(map)[0].geometry.coordinates, [[0.5, 0.5], [2, 2]]);
  assert.deepEqual(mainConnections(map)[1].geometry.coordinates, roadBC.coordinates);

  view.markerManager.markers.forEach((marker, index) => {
    marker.entry.getValue = () => ({ toString: () => String(2 - index) });
  });
  overlay.update();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['fallback', 'fallback']);
  assert.deepEqual(mainConnections(map)[0].geometry.coordinates, [[3, 3], [2, 2]]);
  await waitForRouting();
  assert.equal(client.calls.length, 0);
  assert.equal(cache.serialize().routes.length, 2);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
});

test('a worker result arriving after the view is destroyed cannot enter the persistent cache', async () => {
  let changes = 0;
  const cache = new RoadRouteCache(undefined, () => changes++);
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, errors } = setup(true, client, cache);
  attachRoads(map);
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await waitForRouting();
  assert.equal(client.calls.length, 1);
  overlay.destroy();
  const mutations = map.mutations.length;
  client.finish(0, [roadAB]);
  await flushRouting();
  assert.equal(changes, 0);
  assert.equal(cache.serialize().routes.length, 0);
  assert.equal(map.mutations.length, mutations);
  assert.equal(map.sources.size, 1);
  assert.ok([...map.listeners.values()].every(handlers => handlers.size === 0));
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
});

test('panning to new detailed roads gives the next search both old and new area geometry', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, errors } = setup(true, client);
  const loaded = attachRoads(map);
  const firstArea: RoadFeature = { geometry: { type: 'LineString', coordinates: [[1, 1], [1.5, 1]] }, properties: { class: 'minor' } };
  const secondArea: RoadFeature = { geometry: { type: 'LineString', coordinates: [[1.5, 1], [2, 2]] }, properties: { class: 'minor' } };
  loaded.roads = [firstArea];
  settings[KEYS.routeMode] = 'local';
  overlay.update();
  await waitForRouting();
  assert.equal(client.calls[0].snapshot.features.length, 1);
  client.finish(0, [null]);
  await flushRouting();
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'fallback');

  loaded.roads = [secondArea]; // The first area's tile has left the official map.
  map.emit('moveend');
  map.emit('sourcedata', { sourceId: 'osm' });
  map.emit('idle');
  await waitForRouting();
  assert.equal(client.calls.length, 2);
  const captured = client.calls[1].snapshot;
  assert.equal(captured.features.length, 2);
  assert.ok(captured.features.some(feature => JSON.stringify(feature.geometry) === JSON.stringify(firstArea.geometry)));
  assert.ok(captured.features.some(feature => JSON.stringify(feature.geometry) === JSON.stringify(secondArea.geometry)));
  assert.notEqual(captured.key, client.calls[0].snapshot.key);
  loaded.zoom = 6;
  loaded.roads = [];
  map.emit('moveend');
  map.emit('idle');
  client.finish(1, [roadAB]);
  await flushRouting();
  assert.equal(mainConnections(map)[0].properties.connectionKind, 'road');
  assert.deepEqual(mainConnections(map)[0].geometry.coordinates, roadAB.coordinates);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
});

test('random groups use different consistent colors for solid lines, fallback lines and their arrow bitmaps', () => {
  const { overlay, map, settings, view, errors } = setup();
  groupPairs(view);
  settings[KEYS.group] = 'route';
  settings[KEYS.colorMode] = 'random';
  overlay.update();
  const colors = mainConnections(map).map(feature => feature.properties.lineColor);
  assert.equal(new Set(colors).size, 2);
  assertMatchingArrowImages(map);
  const solid = [...map.layers.values()].find(layer => layer.type === 'line')!;
  assert.deepEqual((solid.paint as Record<string, unknown>)['line-color'], ['get', 'lineColor']);
  const arrows = [...map.layers.values()].find(layer => layer.type === 'symbol')!;
  assert.deepEqual((arrows.layout as Record<string, unknown>)['icon-image'], ['get', 'arrowImage']);
  settings[KEYS.routeMode] = 'local'; // No vector source: both groups become dashed fallback.
  overlay.update();
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['fallback', 'fallback']);
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.lineColor), colors);
  const dashed = [...map.layers.values()].find(layer => (layer.paint as Record<string, unknown> | undefined)?.['line-dasharray'])!;
  assert.deepEqual((dashed.paint as Record<string, unknown>)['line-color'], ['get', 'lineColor']);
  assertMatchingArrowImages(map);
  const mutations = map.mutations.length;
  for (let i = 0; i < 10; i++) map.emit('idle');
  assert.equal(map.mutations.length, mutations);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
});

test('switching random groups to one color removes unused images and restores only owned resources after style reload', () => {
  const { overlay, map, settings, view, errors } = setup();
  groupPairs(view);
  settings[KEYS.group] = 'route';
  settings[KEYS.colorMode] = 'random';
  overlay.update();
  const oldImages = [...map.images.keys()].filter(id => id.startsWith(RESOURCE_PREFIX));
  assert.equal(oldImages.length, 2);
  settings[KEYS.colorMode] = 'single';
  settings[KEYS.color] = '#2583e8';
  overlay.update();
  assert.ok(oldImages.every(id => !map.images.has(id)));
  assert.equal(map.images.size, 2); // One Maps image and one Directions image.
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.lineColor), ['#2583e8', '#2583e8']);
  assertMatchingArrowImages(map);
  map.reloadStyle();
  assert.equal(map.images.size, 2);
  assertMatchingArrowImages(map);
  assertOriginalResources(map);
  overlay.destroy();
  assert.equal(map.images.size, 1);
  assert.equal(map.sources.size, 1);
  assert.equal(map.layers.size, 1);
  assert.ok([...map.listeners.values()].every(handlers => handlers.size === 0));
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
});

test('editing a color property recolors retained road geometry and arrows without another road search', async () => {
  const client = new DeferredRoutingClient();
  const { overlay, map, settings, view, errors } = setup(true, client);
  const roads = attachRoads(map);
  let colorA = '#ff0000';
  const colorB = '#00ff00';
  groupPairs(view, () => colorA, () => colorB);
  settings[KEYS.group] = 'route';
  settings[KEYS.routeMode] = 'local';
  settings[KEYS.colorMode] = 'property';
  settings[KEYS.colorProperty] = 'routeColor';
  overlay.update();
  await waitForRouting();
  const roadCD: RoadRoute = { coordinates: [[3, 3], [3.5, 3], [4, 4]], distance: 120 };
  client.finish(0, [roadAB, roadCD]);
  await flushRouting();
  const geometry = structuredClone(mainConnections(map).map(feature => feature.geometry));
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.lineColor), ['#ff0000', '#00ff00']);
  const oldImage = String(mainConnections(map)[0].properties.arrowImage);
  assertMatchingArrowImages(map);
  const queries = roads.queries;
  colorA = '#2583e8';
  overlay.update();
  await waitForRouting();
  assert.equal(client.calls.length, 1);
  assert.equal(roads.queries, queries);
  assert.deepEqual(mainConnections(map).map(feature => feature.geometry), geometry);
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.connectionKind), ['road', 'road']);
  assert.deepEqual(mainConnections(map).map(feature => feature.properties.lineColor), ['#2583e8', '#00ff00']);
  assert.equal(map.images.has(oldImage), false);
  assertMatchingArrowImages(map);
  assert.deepEqual(errors, []);
  assertOriginalResources(map);
  overlay.destroy();
});
