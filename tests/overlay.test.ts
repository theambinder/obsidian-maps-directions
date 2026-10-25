import assert from 'node:assert/strict';
import test from 'node:test';
import { createArrowImage, DirectionsOverlay, RESOURCE_PREFIX } from '../src/directions-overlay';
import type { FeatureCollection, GeoJSONSourceLike, MapLike, MapsViewLike } from '../src/contracts';
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
  emit(event: string): void { for (const handler of [...this.listeners.get(event) ?? []]) handler(); }
  reloadStyle(): void {
    this.sources = new Map([['maps-markers', { setData() {} }]]);
    this.layers = new Map([['marker-pins', { id: 'marker-pins' }]]);
    this.images = new Map([['maps-pin', { width: 1, height: 1, data: new Uint8Array(4) }]]);
    this.layerOrder = ['marker-pins'];
    this.emit('style.load');
  }
}

function setup(enabled = true) {
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
  const overlay = new DirectionsOverlay(view, error => errors.push(error));
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
