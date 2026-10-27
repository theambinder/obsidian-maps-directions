import assert from 'node:assert/strict';
import test from 'node:test';
import { getBackgroundMapFactory, MapsAdapter, type AdapterStatus } from '../src/adapter';
import type { MapLike, MapsViewLike, OverlayLike } from '../src/contracts';
import type { BackgroundRoadMapOptions } from '../src/background-roads';
import { KEYS } from '../src/settings';
import type { BasesAllOptions } from 'obsidian';

type Fn = (this: unknown, ...args: unknown[]) => unknown;
type TestView = MapsViewLike & { cleanups: Array<() => void>; _children: unknown[] };

test('background preparation reuses a supported installed map constructor with the supplied options', () => {
  const constructed: unknown[] = [];
  class NativeMap {
    camera = { center: [114.1, 22.3], zoom: 11 };
    style = { sources: { markers: { type: 'geojson', data: 'private marker data' } } };
    removed = false;
    constructor(readonly options: unknown) { constructed.push(options); }
    on(): void {}
    off(): void {}
    jumpTo(): void { throw new Error('The original map must not be moved'); }
    remove(): void { this.removed = true; }
    getStyle(): unknown { return this.style; }
    getZoom(): number { return this.camera.zoom; }
    querySourceFeatures(): unknown[] { return []; }
    isStyleLoaded(): boolean { return true; }
  }
  const originalOptions = { userMap: true };
  const original = new NativeMap(originalOptions);
  const originalCamera = original.camera, originalStyle = original.style;
  const factory = getBackgroundMapFactory(original as unknown as MapLike);
  assert.ok(factory);
  assert.deepEqual(constructed, [originalOptions]);
  const options: BackgroundRoadMapOptions = {
    container: {} as HTMLElement,
    style: { version: 8, sources: { roads: { type: 'vector', url: 'https://example.com/roads.json' } }, layers: [] },
    center: [114.1, 22.3], zoom: 14, minZoom: 14, maxZoom: 14,
    bearing: 0, pitch: 0, interactive: false, attributionControl: false, maplibreLogo: false,
    trackResize: false, renderWorldCopies: false, pixelRatio: 1, maxTileCacheSize: 32, fadeDuration: 0,
  };
  const prepared = factory(options);
  assert.ok(prepared instanceof NativeMap);
  assert.notEqual(prepared, original);
  assert.equal(prepared.options, options);
  assert.deepEqual(constructed, [originalOptions, options]);
  assert.equal(original.options, originalOptions);
  assert.equal(original.camera, originalCamera);
  assert.equal(original.style, originalStyle);
  assert.equal(original.removed, false);
});

test('background preparation rejects plain objects and unsupported constructors without instantiating them', () => {
  let constructions = 0;
  class UnsupportedMap { constructor() { constructions++; } }
  class IncompleteMap {
    constructor() { constructions++; }
    on(): void {}
    off(): void {}
    jumpTo(): void {}
    remove(): void {}
    getStyle(): void {}
    getZoom(): number { return 14; }
    // Missing querySourceFeatures means this renderer cannot expose road geometry.
  }
  const candidates = [
    {},
    Object.create(UnsupportedMap.prototype),
    Object.create(IncompleteMap.prototype),
    { constructor: () => { constructions++; } },
    { constructor: {} },
  ];
  for (const candidate of candidates) assert.equal(getBackgroundMapFactory(candidate as MapLike), null);
  assert.equal(constructions, 0);
});

function view(updater: Fn = () => 'markers updated'): TestView {
  const cleanups: Array<() => void> = [];
  return {
    type: 'map', map: null, _children: [], cleanups,
    config: { get: () => undefined, getAsPropertyId: () => null },
    markerManager: { markers: [], updateMarkers: updater },
    register: cleanup => { cleanups.push(cleanup); },
  };
}

class Overlay implements OverlayLike {
  updates = 0;
  destroys = 0;
  failUpdate = false;
  update(): void {
    this.updates++;
    if (this.failUpdate) throw new Error('Directions update failed');
  }
  destroy(): void { this.destroys++; }
}

function harness(options: { factory?: Fn; options?: Fn; overlay?: (view: MapsViewLike) => OverlayLike } = {}) {
  const mapsView = view();
  const registration = { factory: options.factory ?? (() => mapsView), options: options.options ?? (() => [{ type: 'group', displayName: 'Markers' }]) };
  const overlays: Overlay[] = [];
  const statuses: AdapterStatus[] = [];
  const callbacks = new Set<() => void>();
  const ref = {};
  let offrefs = 0;
  let currentPlugin: unknown = { manifest: { version: '0.2.2' } };
  let currentRegistration: unknown = registration;
  const leaves: Array<{ view: unknown }> = [];
  const plugins = {
    manifests: { maps: { version: '0.2.2' } },
    getPlugin: (id: string) => id === 'maps' ? currentPlugin : null,
    on: (event: string, callback: () => void) => { assert.equal(event, 'changed'); callbacks.add(callback); return ref; },
    offref: (value: unknown) => { assert.equal(value, ref); offrefs++; callbacks.clear(); },
  };
  const bases = { getRegistration: (id: string) => { assert.equal(id, 'map'); return currentRegistration; } };
  const app = {
    plugins,
    internalPlugins: { getEnabledPluginById: (id: string) => id === 'bases' ? bases : null },
    workspace: { iterateAllLeaves: (visit: (leaf: { view: unknown }) => void) => leaves.forEach(visit) },
  };
  const adapter = new MapsAdapter(app, options.overlay ?? (() => {
    const overlay = new Overlay();
    overlays.push(overlay);
    return overlay;
  }), status => statuses.push(status));
  return {
    adapter, app, mapsView, registration, overlays, statuses, callbacks, leaves,
    setPlugin: (plugin: unknown) => { currentPlugin = plugin; },
    setRegistration: (value: unknown) => { currentRegistration = value; },
    offrefs: () => offrefs,
    status: () => statuses.at(-1),
  };
}

test('wraps the existing registration, preserves this/arguments/view, and appends settings', t => {
  const map = view();
  const originalGroup = { type: 'group', displayName: 'Markers' };
  const originalOptions = [originalGroup];
  const calls: Array<{ receiver: unknown; args: unknown[] }> = [];
  const h = harness({
    factory: function (...args) { calls.push({ receiver: this, args }); return map; },
    options: function (...args) { calls.push({ receiver: this, args }); return originalOptions; },
  });
  t.after(() => h.adapter.stop());
  const originalRegistration = h.registration;
  h.adapter.start();
  const receiver = {};
  const args = [{}, 'second argument'];
  assert.equal(h.registration, originalRegistration);
  assert.equal(h.registration.factory.apply(receiver, args), map);
  const result = h.registration.options.apply(receiver, args) as Array<{ displayName: string }>;
  assert.deepEqual(calls, [{ receiver, args }, { receiver, args }]);
  assert.equal(result[0], originalGroup);
  assert.deepEqual(result.slice(1).map(group => group.displayName), ['Directions']);
  assert.deepEqual(originalOptions, [originalGroup]);
  assert.equal(h.status()?.state, 'ready');
});

test('passes the original Bases config to live conditional Directions settings without changing its receiver', t => {
  const h = harness();
  t.after(() => h.adapter.stop());
  h.adapter.start();
  const config = {
    mode: 'single',
    get(this: { mode: string }, key: string) { assert.equal(this, config); return key === KEYS.colorMode ? this.mode : undefined; },
  };
  const result = h.registration.options(config) as BasesAllOptions[];
  const directions = result.find(option => option.displayName === 'Directions')!;
  assert.ok(directions.type === 'group');
  const single = directions.items.find(option => option.key === KEYS.color)!;
  const property = directions.items.find(option => option.key === KEYS.colorProperty)!;
  assert.equal(single.shouldHide?.(), false);
  assert.equal(property.shouldHide?.(), true);
  config.mode = 'property';
  assert.equal(single.shouldHide?.(), true);
  assert.equal(property.shouldHide?.(), false);
});

test('defers attachment until Bases assigns config after the factory returns', async t => {
  const map = view();
  const config = map.config;
  delete (map as unknown as Record<string, unknown>).config;
  const h = harness({ factory: () => map });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  assert.equal(h.registration.factory(), map);
  assert.equal(h.overlays.length, 0);
  assert.equal(h.status()?.state, 'ready');
  map.config = config; // The actual Bases controller does this synchronously.
  await Promise.resolve();
  assert.equal(h.overlays.length, 1);
  assert.equal(h.overlays[0].updates, 1);
  assert.equal(h.status()?.state, 'ready');
});

test('an absent config is transient and can attach in a later bounded reconciliation', async t => {
  const map = view();
  const config = map.config;
  delete (map as unknown as Record<string, unknown>).config;
  const h = harness({ factory: () => map });
  t.after(() => h.adapter.stop());
  h.leaves.push({ view: { _children: [map] } });
  h.adapter.start();
  h.registration.factory();
  await Promise.resolve();
  assert.equal(h.overlays.length, 0);
  assert.equal(h.status()?.state, 'ready');
  map.config = config;
  h.adapter.reconcile();
  assert.equal(h.overlays.length, 1);
  assert.equal(h.status()?.state, 'ready');
});

test('unloading an unconfigured view cancels the deferred attachment', async t => {
  const map = view();
  const config = map.config;
  delete (map as unknown as Record<string, unknown>).config;
  const h = harness({ factory: () => map });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  h.registration.factory();
  map.cleanups.forEach(cleanup => cleanup());
  map.config = config;
  await Promise.resolve();
  assert.equal(h.overlays.length, 0);
});

test('preserves synchronous updater receiver, arguments and return value', t => {
  const markerResult = { original: true };
  let calledThis: unknown;
  let calledArgs: unknown[] = [];
  const map = view(function (...args) { calledThis = this; calledArgs = args; return markerResult; });
  const h = harness({ factory: () => map });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  h.registration.factory();
  const receiver = {};
  const args = [{ data: [] }, 'options'];
  assert.equal(map.markerManager.updateMarkers.apply(receiver, args), markerResult);
  assert.equal(calledThis, receiver);
  assert.deepEqual(calledArgs, args);
  assert.equal(h.overlays[0].updates, 2);
});

test('updates directions only after the asynchronous original update succeeds', async t => {
  let resolve!: (value: unknown) => void;
  const result = { original: 'resolved' };
  const promise = new Promise(done => { resolve = done; });
  const map = view(() => promise);
  const h = harness({ factory: () => map });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  h.registration.factory();
  const returned = map.markerManager.updateMarkers();
  assert.equal(h.overlays[0].updates, 1);
  resolve(result);
  assert.equal(await returned, result);
  assert.equal(h.overlays[0].updates, 2);
});

test('an in-flight Maps update still resolves after the addon stops', async () => {
  let resolve!: (value: unknown) => void;
  const result = { original: 'resolved after unload' };
  const promise = new Promise(done => { resolve = done; });
  const map = view(() => promise);
  const h = harness({ factory: () => map });
  h.adapter.start();
  h.registration.factory();
  const returned = map.markerManager.updateMarkers();
  h.adapter.stop();
  resolve(result);
  assert.equal(await returned, result);
  assert.equal(h.overlays[0].updates, 1);
  assert.equal(h.overlays[0].destroys, 1);
});

test('propagates original synchronous errors without running the overlay', t => {
  const error = new Error('Official Maps error');
  const map = view(() => { throw error; });
  const h = harness({ factory: () => map });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  h.registration.factory();
  assert.throws(() => map.markerManager.updateMarkers(), value => value === error);
  assert.equal(h.overlays[0].updates, 1);
  assert.equal(h.status()?.state, 'ready');
});

test('propagates original promise rejections without running the overlay', async t => {
  const error = new Error('Official asynchronous Maps error');
  const map = view(() => Promise.reject(error));
  const h = harness({ factory: () => map });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  h.registration.factory();
  await assert.rejects(map.markerManager.updateMarkers() as Promise<unknown>, value => value === error);
  assert.equal(h.overlays[0].updates, 1);
  assert.equal(h.status()?.state, 'ready');
});

test('does not swallow factory or settings errors from Maps', t => {
  const factoryError = new Error('Official factory error');
  const optionsError = new Error('Official settings error');
  const h = harness({ factory: () => { throw factoryError; }, options: () => { throw optionsError; } });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  assert.throws(() => h.registration.factory(), value => value === factoryError);
  assert.throws(() => h.registration.options(), value => value === optionsError);
});

test('view unload and adapter stop restore only own hooks and destroy once', () => {
  const h = harness();
  const originalFactory = h.registration.factory;
  const originalOptions = h.registration.options;
  const originalUpdate = h.mapsView.markerManager.updateMarkers;
  h.adapter.start();
  h.adapter.start();
  h.registration.factory();
  h.registration.factory();
  assert.equal(h.overlays.length, 1);
  assert.equal(h.mapsView.cleanups.length, 1);
  h.mapsView.cleanups[0]();
  h.mapsView.cleanups[0]();
  assert.equal(h.overlays[0].destroys, 1);
  assert.equal(h.mapsView.markerManager.updateMarkers, originalUpdate);
  h.adapter.stop();
  h.adapter.stop();
  assert.equal(h.registration.factory, originalFactory);
  assert.equal(h.registration.options, originalOptions);
  assert.equal(h.offrefs(), 1);
});

test('stop preserves hooks installed later by another addon', () => {
  const h = harness();
  h.adapter.start();
  h.registration.factory();
  const addonFactory = h.registration.factory;
  const addonOptions = h.registration.options;
  const addonUpdater = h.mapsView.markerManager.updateMarkers;
  const laterFactory = (...args: unknown[]) => addonFactory(...args);
  const laterOptions = (...args: unknown[]) => addonOptions(...args);
  const laterUpdater = (...args: unknown[]) => addonUpdater(...args);
  h.registration.factory = laterFactory;
  h.registration.options = laterOptions;
  h.mapsView.markerManager.updateMarkers = laterUpdater;
  h.adapter.stop();
  assert.equal(h.registration.factory, laterFactory);
  assert.equal(h.registration.options, laterOptions);
  assert.equal(h.mapsView.markerManager.updateMarkers, laterUpdater);
  assert.equal(h.registration.factory(), h.mapsView);
  assert.equal((h.registration.options() as unknown[]).length, 1);
  h.mapsView.markerManager.updateMarkers();
  assert.equal(h.overlays[0].destroys, 1);
  assert.equal(h.overlays[0].updates, 1);
});

test('missing Maps leaves the original registration untouched and attaches on enable', t => {
  const h = harness();
  const originalFactory = h.registration.factory;
  const originalOptions = h.registration.options;
  h.setPlugin(null);
  t.after(() => h.adapter.stop());
  h.adapter.start();
  assert.equal(h.status()?.state, 'waiting');
  assert.equal(h.registration.factory, originalFactory);
  assert.equal(h.registration.options, originalOptions);
  h.setPlugin({});
  h.callbacks.forEach(callback => callback());
  assert.equal(h.status()?.state, 'ready');
  h.registration.factory();
  assert.equal(h.overlays.length, 1);
  h.setPlugin(null);
  h.callbacks.forEach(callback => callback());
  assert.equal(h.status()?.state, 'waiting');
  assert.equal(h.registration.factory, originalFactory);
  assert.equal(h.overlays[0].destroys, 1);
});

test('reconciles registration replacement and restores the old registration', t => {
  const h = harness();
  t.after(() => h.adapter.stop());
  const oldFactory = h.registration.factory;
  h.adapter.start();
  h.registration.factory();
  const nextView = view();
  const nextFactory = () => nextView;
  const next = { factory: nextFactory, options: () => [] };
  h.setRegistration(next);
  h.adapter.reconcile();
  assert.equal(h.registration.factory, oldFactory);
  assert.equal(h.overlays[0].destroys, 1);
  assert.notEqual(next.factory, nextFactory);
  assert.equal(next.factory(), nextView);
  assert.equal(h.overlays.length, 2);
});

test('a failing addon update disables only its overlay and preserves original results', t => {
  const h = harness();
  t.after(() => h.adapter.stop());
  const originalUpdate = h.mapsView.markerManager.updateMarkers;
  h.adapter.start();
  h.registration.factory();
  h.overlays[0].failUpdate = true;
  assert.equal(h.mapsView.markerManager.updateMarkers(), 'markers updated');
  assert.equal(h.mapsView.markerManager.updateMarkers, originalUpdate);
  assert.equal(h.overlays[0].destroys, 1);
  assert.equal(h.status()?.state, 'incompatible');
  h.adapter.reconcile();
  assert.equal(h.status()?.state, 'incompatible');
  assert.equal(h.registration.factory(), h.mapsView);
  assert.equal(h.overlays.length, 1);
});

test('a failing overlay constructor never changes the original Maps view', t => {
  const h = harness({ overlay: () => { throw new Error('Directions construction failed'); } });
  t.after(() => h.adapter.stop());
  const updater = h.mapsView.markerManager.updateMarkers;
  h.adapter.start();
  assert.equal(h.registration.factory(), h.mapsView);
  assert.equal(h.mapsView.markerManager.updateMarkers, updater);
  assert.equal(h.status()?.state, 'incompatible');
});

test('incompatible views and settings formats are returned unchanged', t => {
  const invalidView = { type: 'map' };
  const invalidOptions = { futureSettings: true };
  const h = harness({ factory: () => invalidView, options: () => invalidOptions });
  t.after(() => h.adapter.stop());
  h.adapter.start();
  assert.equal(h.registration.factory(), invalidView);
  assert.equal(h.status()?.state, 'incompatible');
  assert.equal(h.registration.options(), invalidOptions);
  assert.equal(h.overlays.length, 0);
});

test('an unsupported registration is never modified', t => {
  const h = harness();
  const unsupported = { factory: () => view(), options: { futureFormat: true } };
  const factory = unsupported.factory;
  const options = unsupported.options;
  h.setRegistration(unsupported);
  t.after(() => h.adapter.stop());
  h.adapter.start();
  assert.equal(h.status()?.state, 'incompatible');
  assert.equal(unsupported.factory, factory);
  assert.equal(unsupported.options, options);
  assert.equal(h.overlays.length, 0);
});

test('attaches existing Map views through the internal Component child tree', t => {
  const h = harness();
  t.after(() => h.adapter.stop());
  const component: { _children: unknown[] } = { _children: [] };
  const controller = { _children: [h.mapsView, component] };
  component._children.push(controller); // Component-like cycles must be harmless.
  h.leaves.push({ view: { _children: [component] } });
  h.adapter.start();
  h.adapter.reconcile();
  assert.equal(h.overlays.length, 1);
  assert.equal(h.mapsView.cleanups.length, 1);
  assert.equal(h.overlays[0].updates, 1);
});

test('future Maps versions are accepted when the boundary shape is compatible', t => {
  const h = harness();
  t.after(() => h.adapter.stop());
  h.app.plugins.manifests.maps.version = '2.0.0';
  h.adapter.start();
  assert.equal(h.status()?.state, 'ready');
  assert.match(h.status()?.message ?? '', /2\.0\.0/);
  h.registration.factory();
  assert.equal(h.overlays.length, 1);
});

test('detach supports Events.off when offref is unavailable', () => {
  const h = harness();
  let removed = false;
  const plugins = h.app.plugins as unknown as Record<string, unknown>;
  delete plugins.offref;
  plugins.off = (event: unknown, listener: unknown) => {
    assert.equal(event, 'changed');
    assert.ok(h.callbacks.has(listener as () => void));
    removed = true;
  };
  h.adapter.start();
  h.adapter.stop();
  assert.equal(removed, true);
});
