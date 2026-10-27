import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRoadPreparationStyle, prepareBackgroundRoads,
  type BackgroundRoadMap, type BackgroundRoadMapOptions, type RoadPreparationCenter, type RoadPreparationArea,
} from '../src/background-roads';
import type { RoadFeature } from '../src/road-graph';

const sourceStyle = (): Record<string, unknown> => ({
  version: 8, sprite: 'https://tiles.example/sprites', glyphs: 'https://tiles.example/glyphs/{fontstack}/{range}.pbf',
  sources: {
    roads: { type: 'vector', url: 'https://tiles.example/roads.json', minzoom: 0, maxzoom: 14,
      bounds: [-180, -85, 180, 85], attribution: 'Road attribution', ignored: 'not copied' },
    markers: { type: 'geojson', data: { privateNote: 'private marker note content' } },
    imagery: { type: 'raster', tiles: ['https://tiles.example/photos/{z}/{x}/{y}'] },
  },
  layers: [
    { id: 'road-labels', type: 'symbol', source: 'roads', 'source-layer': 'transportation', layout: { 'text-field': 'private note label' } },
    { id: 'marker-pins', type: 'symbol', source: 'markers' },
    { id: 'imagery', type: 'raster', source: 'imagery' },
  ],
});

class FakeDocument {
  readonly body = new FakeElement(this);
  createElement(): FakeElement { return new FakeElement(this); }
}
class FakeElement {
  parent: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly style: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  className = '';
  constructor(readonly ownerDocument: FakeDocument) {}
  append(child: FakeElement): void { child.parent = this; this.children.push(child); }
  remove(): void {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
}

class FakeMap implements BackgroundRoadMap {
  readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  readonly jumps: RoadPreparationCenter[] = [];
  removed = 0;
  ready = false;
  current: RoadPreparationCenter;
  currentZoom: number;
  readonly zooms: number[] = [];
  mode: 'idle' | 'source' | 'silent' = 'idle';
  roads = true;
  constructor(readonly options: BackgroundRoadMapOptions) { this.current = options.center; this.currentZoom = options.zoom; }
  getStyle(): unknown { return this.options.style; }
  getZoom(): number { return this.currentZoom; }
  isStyleLoaded(): boolean { return this.ready; }
  loaded(): boolean { return this.ready; }
  areTilesLoaded(): boolean { return this.ready; }
  querySourceFeatures(): RoadFeature[] {
    const [x, y] = this.current;
    return this.roads ? [{ geometry: { type: 'LineString', coordinates: [[x, y], [x + 0.001, y]] }, properties: { class: 'minor' } }] : [];
  }
  jumpTo(options: { center: RoadPreparationCenter; zoom: number }): void {
    this.current = options.center;
    this.currentZoom = options.zoom;
    this.zooms.push(options.zoom);
    this.jumps.push(options.center);
    if (this.mode !== 'silent') queueMicrotask(() => {
      this.ready = true;
      this.emit(this.mode === 'source' ? 'sourcedata' : 'idle');
    });
  }
  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }
  off(event: string, handler: (...args: unknown[]) => void): void { this.handlers.get(event)?.delete(handler); }
  emit(event: string): void { for (const handler of [...this.handlers.get(event) ?? []]) handler(); }
  remove(): void { this.removed++; }
  listenerCount(): number { return [...this.handlers.values()].reduce((count, handlers) => count + handlers.size, 0); }
}

function fixture(style: unknown = sourceStyle()): {
  doc: FakeDocument; original: { getStyle(): unknown; getContainer(): HTMLElement; jumpTo(): never; flyTo(): never };
} {
  const doc = new FakeDocument();
  const container = doc.createElement();
  return { doc, original: {
    getStyle: () => style, getContainer: () => container as unknown as HTMLElement,
    jumpTo: () => { throw new Error('The original camera must stay unchanged.'); },
    flyTo: () => { throw new Error('The original camera must stay unchanged.'); },
  } };
}

test('preparation style copies only supported transportation vector sources and no note or marker content', () => {
  const original = sourceStyle();
  const prepared = buildRoadPreparationStyle(original)!;
  assert.deepEqual(Object.keys(prepared.sources), ['roads']);
  assert.deepEqual(prepared.layers, [{ id: 'maps-directions-road-preparation-0', type: 'line', source: 'roads',
    'source-layer': 'transportation', paint: { 'line-color': '#777777', 'line-width': 1 } }]);
  const serialized = JSON.stringify(prepared);
  for (const excluded of ['private', 'markers', 'imagery', 'sprite', 'glyphs', 'ignored']) assert.ok(!serialized.includes(excluded));
  assert.equal(prepared.sources.roads.url, 'https://tiles.example/roads.json');
  (prepared.sources.roads.bounds as number[])[0] = 0;
  assert.equal(((original.sources as Record<string, Record<string, unknown>>).roads.bounds as number[])[0], -180);
});

test('preparation style accepts tile templates and rejects incompatible or malformed sources', () => {
  const prepared = buildRoadPreparationStyle({ sources: {
    tiles: { type: 'vector', tiles: ['local://roads/{z}/{x}/{y}'], scheme: 'tms', tileSize: 512, encoding: 'mvt' },
    missing: { type: 'vector' }, bad: { type: 'vector', tiles: [12] }, raster: { type: 'raster', url: 'https://example.test' },
  }, layers: ['tiles', 'missing', 'bad', 'raster'].map(source => ({ source, 'source-layer': 'transportation' })) })!;
  assert.deepEqual(Object.keys(prepared.sources), ['tiles']);
  assert.deepEqual(prepared.sources.tiles.tiles, ['local://roads/{z}/{x}/{y}']);
  assert.equal(prepared.sources.tiles.scheme, 'tms');
  assert.equal(prepared.sources.tiles.tileSize, 512);
  assert.equal(prepared.sources.tiles.encoding, 'mvt');
  assert.equal(buildRoadPreparationStyle({ sources: {}, layers: [] }), null);
  assert.equal(buildRoadPreparationStyle(null), null);
});

test('one offscreen map prepares areas sequentially without changing the original map and always cleans up', async () => {
  const { doc, original } = fixture();
  let map!: FakeMap;
  const captured: number[] = [];
  const progress: unknown[] = [];
  const result = await prepareBackgroundRoads(original, [[114, 22], [114.1, 22]], {
    factory: options => { map = new FakeMap(options); return map; },
    onSnapshot: snapshot => { captured.push((snapshot.features[0].geometry!.coordinates as number[][])[0][0]); },
    onProgress: next => progress.push(next),
  });
  assert.deepEqual(result, { completed: 2, total: 2, ready: 2, timedOut: false });
  assert.deepEqual(captured, [114, 114.10000000000002]);
  assert.equal(progress.length, 3);
  assert.deepEqual(map.jumps, [[114, 22], [114.10000000000002, 22]]);
  assert.equal(map.options.interactive, false);
  assert.equal(map.options.pixelRatio, 1);
  assert.equal(map.options.maxTileCacheSize, 32);
  const host = map.options.container as unknown as FakeElement;
  assert.equal(host.style.visibility, 'hidden');
  assert.equal(host.style.width, '1024px');
  assert.equal(host.style.height, '768px');
  assert.notEqual(host.style.display, 'none');
  assert.equal(host.attributes['aria-hidden'], 'true');
  assert.equal(doc.body.children.length, 0);
  assert.equal(map.listenerCount(), 0);
  assert.equal(map.removed, 1);
});

test('snapshot callbacks apply backpressure and can stop preparation successfully', async () => {
  const { doc, original } = fixture();
  let map!: FakeMap;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const operation = prepareBackgroundRoads(original, [[114, 22], [115, 22]], {
    factory: options => { map = new FakeMap(options); return map; },
    onSnapshot: async () => { await gate; return false; },
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(map.jumps.length, 1);
  assert.equal(doc.body.children.length, 1);
  release();
  assert.deepEqual(await operation, { completed: 1, total: 2, ready: 1, timedOut: false });
  assert.equal(map.jumps.length, 1);
  assert.equal(map.removed, 1);
  assert.equal(doc.body.children.length, 0);
});

test('source-loaded events finish an area without depending on a later idle event', async () => {
  const { original } = fixture();
  let map!: FakeMap;
  const result = await prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => { map = new FakeMap(options); map.mode = 'source'; return map; },
    onSnapshot: () => {},
  });
  assert.equal(result.ready, 1);
  assert.equal(map.listenerCount(), 0);
});

test('area timeouts report partial detail and empty areas are reported without pretending a road search succeeded', async () => {
  const { original } = fixture();
  let calls = 0;
  const partial = await prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => { const map = new FakeMap(options); map.mode = 'silent'; map.ready = true; return map; },
    timeoutMs: 2, onSnapshot: () => { calls++; },
  });
  assert.equal(partial.ready, 1);
  assert.equal(partial.timedOut, false);
  const empty = await prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => { const map = new FakeMap(options); map.roads = false; return map; },
    onSnapshot: () => { calls++; },
  });
  assert.equal(empty.completed, 1);
  assert.equal(empty.ready, 0);
  assert.equal(calls, 2);
});

test('user cancellation during tile loading removes listeners, host and temporary map', async () => {
  const { doc, original } = fixture();
  const controller = new AbortController();
  let map!: FakeMap;
  const operation = prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => { map = new FakeMap(options); map.mode = 'silent'; return map; },
    signal: controller.signal, onSnapshot: () => {},
  });
  controller.abort();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(map.listenerCount(), 0);
  assert.equal(map.removed, 1);
  assert.equal(doc.body.children.length, 0);
  await assert.rejects(prepareBackgroundRoads(original, [[114, 22]], {
    factory: () => { throw new Error('Already-aborted work must not construct a map.'); },
    signal: controller.signal, onSnapshot: () => {},
  }), { name: 'AbortError' });
});

test('cancellation during a pending snapshot callback cleans up immediately', async () => {
  const { doc, original } = fixture();
  const controller = new AbortController();
  let map!: FakeMap;
  const operation = prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => { map = new FakeMap(options); return map; }, signal: controller.signal,
    onSnapshot: () => { controller.abort(); return new Promise(() => {}); },
  });
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(map.removed, 1);
  assert.equal(doc.body.children.length, 0);
});

test('the overall deadline stops an unavailable background without waiting through every target', async () => {
  const { doc, original } = fixture();
  let map!: FakeMap;
  const result = await prepareBackgroundRoads(original, [[114, 22], [115, 22]], {
    factory: options => { map = new FakeMap(options); map.mode = 'silent'; return map; },
    totalTimeoutMs: 5, onSnapshot: () => { throw new Error('No detail was loaded.'); },
  });
  assert.deepEqual(result, { completed: 0, total: 2, ready: 0, timedOut: true });
  assert.equal(map.jumps.length, 1);
  assert.equal(map.listenerCount(), 0);
  assert.equal(map.removed, 1);
  assert.equal(doc.body.children.length, 0);
});

test('factory and snapshot errors release temporary resources and propagate to the caller', async () => {
  const { doc, original } = fixture();
  await assert.rejects(prepareBackgroundRoads(original, [[114, 22]], {
    factory: () => { throw new Error('WebGL unavailable'); }, onSnapshot: () => {},
  }), /WebGL unavailable/);
  assert.equal(doc.body.children.length, 0);
  let map!: FakeMap;
  await assert.rejects(prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => { map = new FakeMap(options); return map; }, onSnapshot: () => { throw new Error('Worker unavailable'); },
  }), /Worker unavailable/);
  assert.equal(map.removed, 1);
  assert.equal(doc.body.children.length, 0);
});

test('target validation retains every valid caller-selected area without an itinerary-length cutoff', async () => {
  const { original } = fixture();
  let map!: FakeMap;
  const centers = Array.from({ length: 70 }, (_, i): RoadPreparationCenter => [114 + i / 100, 22]);
  const result = await prepareBackgroundRoads(original, [[NaN, 22], [114, 90], ...centers], {
    factory: options => { map = new FakeMap(options); return map; }, onSnapshot: () => {},
  });
  assert.equal(result.total, 70);
  assert.equal(result.completed, 70);
  assert.equal(map.jumps.length, 70);
  assert.deepEqual(await prepareBackgroundRoads(original, [], {
    factory: () => { throw new Error('Empty target list must not construct a map.'); }, onSnapshot: () => {},
  }), { completed: 0, total: 0, ready: 0, timedOut: false });
});

test('unsupported source styles fail before constructing a map or appending a host', async () => {
  const { doc, original } = fixture({ sources: { private: { type: 'geojson', data: 'private data' } }, layers: [] });
  await assert.rejects(prepareBackgroundRoads(original, [[114, 22]], {
    factory: () => { throw new Error('Unsupported styles must not construct a map.'); }, onSnapshot: () => {},
  }), /supported vector roads/);
  assert.equal(doc.body.children.length, 0);
});


test('adaptive target zooms and workload viewport limits affect only the temporary map', async () => {
  const { doc, original } = fixture();
  let map!: FakeMap;
  const areas: RoadPreparationArea[] = [];
  const result = await prepareBackgroundRoads(original, [
    { center: [114, 22], zoom: 6 }, { center: [114, 22], zoom: 14 }, { center: [114.01, 22], zoom: 16 },
  ], {
    factory: options => { map = new FakeMap(options); return map; },
    viewportWidth: 768, viewportHeight: 512, tileCacheSize: 8,
    onSnapshot: (snapshot, signal, area) => {
      assert.equal(signal.aborted, false);
      assert.equal(snapshot.state, 'ready');
      assert.ok(area); areas.push(area);
    },
  });
  assert.equal(result.ready, 3);
  assert.deepEqual(map.zooms, [6, 14, 16]);
  assert.equal(map.options.zoom, 6);
  assert.equal(map.options.minZoom, 0);
  assert.equal(map.options.maxZoom, 16);
  assert.equal(map.options.maxTileCacheSize, 8);
  const host = map.options.container as unknown as FakeElement;
  assert.equal(host.style.width, '768px');
  assert.equal(host.style.height, '512px');
  assert.deepEqual(areas.map(area => area.index), [0, 1, 2]);
  assert.deepEqual(areas.map(area => area.target.zoom), [6, 14, 16]);
  assert.ok(areas.every(area => !area.waitTimedOut));
  assert.equal(map.removed, 1);
  assert.equal(doc.body.children.length, 0);
});

test('working road limits report limited data explicitly without treating it as a completed no-path search', async () => {
  const { original } = fixture();
  const states: string[] = [];
  const result = await prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => {
      const map = new FakeMap(options);
      map.querySourceFeatures = () => [0, 1].map(i => ({ geometry: { type: 'LineString', coordinates: [[114 + i / 100, 22], [114.001 + i / 100, 22]] }, properties: { class: 'minor' } }));
      return map;
    },
    roadLimits: { maxFeatures: 1, maxPositions: 50 },
    onSnapshot: snapshot => { states.push(snapshot.state); assert.equal(snapshot.features.length, 0); },
  });
  assert.equal(result.completed, 1);
  assert.equal(result.ready, 0);
  assert.deepEqual(states, ['limited']);
});

test('per-area partial waits are identified for coverage diagnostics', async () => {
  const { original } = fixture();
  let meta: RoadPreparationArea | undefined;
  await prepareBackgroundRoads(original, [[114, 22]], {
    factory: options => { const map = new FakeMap(options); map.ready = true; map.mode = 'silent'; return map; },
    timeoutMs: 2,
    onSnapshot: (snapshot, signal, area) => { assert.equal(snapshot.state, 'ready'); meta = area; },
  });
  assert.equal(meta?.waitTimedOut, true);
});

test('a chunk deadline returns its completed prefix so the next chunk can resume without reloading it', async () => {
  const { original } = fixture();
  let map!: FakeMap;
  const targets: RoadPreparationCenter[] = [[114, 22], [115, 22], [116, 22]];
  const first = await prepareBackgroundRoads(original, targets, {
    factory: options => { map = new FakeMap(options); return map; },
    totalTimeoutMs: 20,
    onSnapshot: () => { map.mode = 'silent'; },
  });
  assert.deepEqual(first, { completed: 1, total: 3, ready: 1, timedOut: true });
  const resumed: RoadPreparationCenter[] = [];
  const second = await prepareBackgroundRoads(original, targets.slice(first.completed), {
    factory: options => new FakeMap(options),
    onSnapshot: (snapshot, signal, area) => { resumed.push(area!.target.center); },
  });
  assert.equal(second.completed, 2);
  assert.deepEqual(resumed, [[115, 22], [116, 22]]);
});


test('a whole-world overview at zoom zero is processed and retains the cursor before street detail', async () => {
  const { original } = fixture();
  let map!: FakeMap;
  const indexes: number[] = [];
  const result = await prepareBackgroundRoads(original, [
    { center: [0, 0], zoom: 0 }, { center: [120, 22], zoom: 14 },
  ], {
    factory: options => { map = new FakeMap(options); return map; },
    onSnapshot: (snapshot, signal, area) => { assert.equal(snapshot.state, 'ready'); indexes.push(area!.index); },
  });
  assert.deepEqual(result, { completed: 2, total: 2, ready: 2, timedOut: false });
  assert.deepEqual(map.zooms, [0, 14]);
  assert.equal(map.options.minZoom, 0);
  assert.deepEqual(indexes, [0, 1]);
});
