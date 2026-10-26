import assert from 'node:assert/strict';
import test from 'node:test';
import { applyRoadRoutes, createArrowImage, DirectionsOverlay, RESOURCE_PREFIX } from '../src/directions-overlay';
import type { RoutingClient } from '../src/local-routing-client';
import type { RoadRoute, RoutingResult } from '../src/routing-protocol';
import type { RoadFeature } from '../src/road-graph';
import type { FeatureCollection, GeoJSONSourceLike, MapLike, MapsMarker, MapsViewLike } from '../src/contracts';
import { KEYS } from '../src/settings';

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

function setup(enabled = true, client?: RoutingClient) {
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
  const overlay = new DirectionsOverlay(view, error => errors.push(error), client);
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
    legs: Parameters<RoutingClient['route']>[1];
    resolve: (result: RoutingResult) => void;
    reject: (error: Error) => void;
  }> = [];
  cancellations = 0;
  route(_snapshot: Parameters<RoutingClient['route']>[0], legs: Parameters<RoutingClient['route']>[1]): Promise<RoutingResult> {
    return new Promise((resolve, reject) => { this.calls.push({ legs, resolve, reject }); });
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
