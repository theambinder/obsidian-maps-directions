import assert from 'node:assert/strict';
import test from 'node:test';
import { processTripQueue, tripPause, type TripProcessorOptions } from '../src/trip-processor';
import { TripQueue, tripConnectionKey, type TripArea, type TripConnection } from '../src/trip-queue';
import { PreparationQueue } from '../src/auto-preparation';
import type { MapLike } from '../src/contracts';
import type { RoutingClient } from '../src/local-routing-client';
import type { RoadFeature, RoadRoute } from '../src/road-graph';
import type { RoadSnapshot } from '../src/local-roads';
import type { RoutingResult } from '../src/routing-protocol';
import { workloadProfile, type WorkloadProfile } from '../src/workload-settings';
import { prepareBackgroundRoads, type BackgroundRoadPreparationOptions, type RoadPreparationArea, type RoadPreparationResult, type RoadPreparationTarget } from '../src/background-roads';

const road: RoadRoute = { coordinates: [[114, 22], [114.001, 22.001], [114.002, 22]], distance: 300 };
const feature = (offset = 0): RoadFeature => ({ geometry: { type: 'LineString', coordinates: [[114 + offset, 22], [114.002 + offset, 22]] }, properties: { class: 'minor' } });
const area = (index = 0, zoom = 14): TripArea => ({ center: [114 + index / 1000, 22], zoom, stage: 'corridor' });
const connection = (key: string, areas = [area()]): TripConnection => ({ key, from: [114, 22], to: [114.002, 22], areas });
const profile = (overrides: Partial<WorkloadProfile> = {}): WorkloadProfile => ({ ...workloadProfile({ mode: 'eco', pauseMs: 0 }), ...overrides });
const snapshot = (id: number, state: RoadSnapshot['state'] = 'ready', roads: RoadFeature[] = [feature()]): RoadSnapshot => ({ key: `roads-${id}`, state, sources: ['osm'], features: state === 'ready' ? roads : [] });

class TestClient implements RoutingClient {
  calls: Array<{ snapshot: RoadSnapshot; legs: Parameters<RoutingClient['route']>[1] }> = [];
  cancellations = 0;
  timeouts: number[] = [];
  constructor(readonly respond: (index: number, data: RoadSnapshot) => { route: RoadRoute | null; truncated?: boolean } = () => ({ route: null })) {}
  async route(data: RoadSnapshot, legs: Parameters<RoutingClient['route']>[1]): Promise<RoutingResult> {
    const index = this.calls.length; this.calls.push({ snapshot: data, legs });
    const response = this.respond(index, data);
    return { id: index, routes: [response.route], stats: { nodes: 10, edges: 9, truncated: response.truncated ?? false } };
  }
  cancel(): void { this.cancellations++; }
  configure(timeout: number): void { this.timeouts.push(timeout); }
}
class DeferredClient implements RoutingClient {
  calls: Array<{ data: RoadSnapshot; resolve: (result: RoutingResult) => void; reject: (error: Error) => void; settled: boolean }> = [];
  cancellations = 0;
  route(data: RoadSnapshot): Promise<RoutingResult> {
    return new Promise((resolve, reject) => this.calls.push({ data, resolve, reject, settled: false }));
  }
  finish(index: number, path: RoadRoute | null): void {
    const call = this.calls[index]; call.settled = true;
    call.resolve({ id: index, routes: [path], stats: { nodes: 10, edges: 9, truncated: false } });
  }
  cancel(): void {
    this.cancellations++;
    for (const call of this.calls) if (!call.settled) { call.settled = true; call.reject(new Error('Stopped')); }
  }
}
interface RunCall { targets: readonly (Parameters<typeof prepareBackgroundRoads>[1][number])[]; options: BackgroundRoadPreparationOptions }
class BackgroundRunner {
  readonly calls: RunCall[] = [];
  constructor(readonly select: (call: number, index: number, target: RoadPreparationTarget) => { data: RoadSnapshot; waitTimedOut?: boolean } = (call, index) => ({ data: snapshot(call * 100 + index) })) {}
  readonly run: typeof prepareBackgroundRoads = async (_original, targets, options) => {
    const call = this.calls.length; this.calls.push({ targets, options });
    const result: RoadPreparationResult = { completed: 0, total: targets.length, ready: 0, timedOut: false };
    for (const [index, input] of targets.entries()) {
      if (options.signal?.aborted) throw new Error('Aborted');
      const target: RoadPreparationTarget = Array.isArray(input) ? { center: input, zoom: 14 } : input;
      const value = this.select(call, index, target);
      const metadata: RoadPreparationArea = { index, target, waitTimedOut: value.waitTimedOut ?? false };
      const keepGoing = await options.onSnapshot(value.data, options.signal!, metadata);
      if (value.data.state === 'ready') result.ready++;
      result.completed++;
      options.onProgress?.({ completed: result.completed, total: result.total, ready: result.ready });
      if (keepGoing === false) break;
    }
    return result;
  };
}
function setup(connections: TripConnection[] = [connection('a')], options: { client?: RoutingClient; background?: BackgroundRunner; profile?: WorkloadProfile; serial?: PreparationQueue; ledger?: TripQueue; visible?: () => boolean } = {}) {
  const ledger = options.ledger ?? new TripQueue();
  const keys = ledger.reconcile(connections);
  const client = options.client ?? new TestClient();
  const background = options.background ?? new BackgroundRunner();
  const controller = new AbortController();
  const progress: Array<{ key: string; completed: number; total: number; message: string }> = [];
  const found: Array<{ key: string; route: RoadRoute }> = [];
  const configuration: TripProcessorOptions = {
    original: {} as MapLike, keys, ledger, serial: options.serial ?? new PreparationQueue(),
    factory: () => { throw Error('The injected fake runner should never create a map.'); }, client,
    profile: () => options.profile ?? profile(), signal: controller.signal, run: background.run,
    visible: options.visible ?? (() => true), onProgress: value => progress.push(value),
    onRoute: (key, route) => found.push({ key, route }),
  };
  return { ledger, keys, client, background, controller, progress, found, configuration };
}
const flush = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };

// These tests inject loading and routing; no browser, map tiles or network are used.
test('every connection beyond the old 200 limit is processed, saved and gets an independent working network', async () => {
  const client = new TestClient(() => ({ route: road }));
  const subject = setup(Array.from({ length: 225 }, (_, index) => connection(`leg-${index}`)), { client });
  await processTripQueue(subject.configuration);
  assert.equal(subject.background.calls.length, 225);
  assert.equal(subject.ledger.snapshot().total, 225);
  assert.equal(subject.ledger.snapshot().ready, 225);
  assert.equal(subject.ledger.snapshot().percentRemaining, 0);
  assert.equal(subject.found.length, 225);
  assert.ok(client.calls.every(call => call.snapshot.features.length === 1));
  assert.ok(client.cancellations >= 225);
  const restored = new TripQueue(subject.ledger.serialize());
  assert.equal(restored.snapshot().ready, 225);
  assert.deepEqual(restored.get('leg-224')?.route, road);
});

test('a reverse walking connection reuses a same-source saved path without another map or graph', async () => {
  const forward = connection(tripConnectionKey([114, 22], [114.002, 22], 'null'));
  const reverse = { ...forward, key: tripConnectionKey(forward.to, forward.from, 'null'), from: forward.to, to: forward.from };
  const subject = setup([forward, reverse]);
  subject.ledger.finish(forward.key, 'ready', undefined, road);
  await processTripQueue(subject.configuration);
  assert.equal(subject.background.calls.length, 0);
  assert.equal(subject.found.length, 1);
  assert.deepEqual(subject.found[0].route.coordinates, [...road.coordinates].reverse());
  assert.deepEqual(subject.ledger.get(forward.key)?.route, road);
  assert.equal(subject.ledger.snapshot().ready, 2);
});

test('reverse reuse cannot cross a map-source boundary or exceed the current pin-access allowance', async () => {
  for (const rejected of ['source', 'access']) {
    const forward = connection(tripConnectionKey([114, 22], [114.002, 22], rejected === 'source' ? 'different-source' : 'null'));
    const reverse = { ...forward, key: tripConnectionKey(forward.to, forward.from, 'null'), from: forward.to, to: forward.from };
    const subject = setup([forward, reverse], { profile: profile({ maxAccessMeters: 100 }) });
    const saved = rejected === 'access' ? { ...road, coordinates: road.coordinates.map(point => [point[0], point[1] + 0.002] as [number, number]) } : road;
    subject.ledger.finish(forward.key, 'ready', undefined, saved);
    await processTripQueue(subject.configuration);
    assert.equal(subject.background.calls.length, 1);
    assert.doesNotMatch(subject.ledger.status(reverse.key)?.reason ?? '', /Reused the reverse/);
  }
});

test('small chunks checkpoint their exact completed prefix and resume the next area without repeating previous chunks', async () => {
  const subject = setup([connection('a', [area(0), area(1), area(2), area(3), area(4)])]);
  await processTripQueue(subject.configuration);
  assert.deepEqual(subject.background.calls.map(call => call.targets.length), [2, 2, 1]);
  assert.deepEqual(subject.background.calls.map(call => (call.targets[0] as TripArea).center), [[114, 22], [114.002, 22], [114.004, 22]]);
  assert.equal(subject.ledger.get('a')?.nextArea, 5);
  assert.equal(subject.ledger.get('a')?.state, 'no-path');
  assert.ok(subject.progress.some(value => value.completed === 2));
  assert.ok(subject.progress.some(value => value.completed === 4));
  assert.equal(subject.background.calls[0].options.viewportWidth, 768);
  assert.equal(subject.background.calls[0].options.viewportHeight, 512);
});

test('finding a path checkpoints the actual visited area before recording a durable ready result', async () => {
  const subject = setup([connection('a', [area(0), area(1), area(2)])], { client: new TestClient(() => ({ route: road })) });
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('a')?.state, 'ready');
  assert.equal(subject.ledger.get('a')?.nextArea, 1);
  assert.equal(subject.background.calls.length, 1);
  assert.equal(subject.background.calls[0].targets.length, 2);
  assert.deepEqual(subject.ledger.get('a')?.route, road);
});

test('aborting an active connection keeps completed paths and requeues only its unfinished road geometry', async () => {
  const deferred = new DeferredClient();
  const subject = setup([connection('done'), connection('active')], { client: deferred });
  const operation = processTripQueue(subject.configuration);
  await flush(); assert.equal(deferred.calls.length, 1);
  deferred.finish(0, road); await flush();
  assert.equal(subject.ledger.get('done')?.state, 'ready');
  assert.equal(deferred.calls.length, 2);
  subject.controller.abort();
  await assert.rejects(operation);
  assert.equal(subject.ledger.get('done')?.state, 'ready');
  assert.deepEqual(subject.ledger.get('done')?.route, road);
  assert.equal(subject.ledger.get('active')?.state, 'queued');
  assert.equal(subject.ledger.get('active')?.nextArea, 0);
  assert.ok(deferred.cancellations > 0);
});

test('a user-paused connection cannot be resurrected by a late worker result', async () => {
  const client = new DeferredClient(), subject = setup([connection('a')], { client });
  const operation = processTripQueue(subject.configuration);
  await flush(); assert.equal(client.calls.length, 1);
  subject.ledger.pause('a', 'Paused by user.');
  client.finish(0, road);
  await operation;
  assert.equal(subject.ledger.get('a')?.state, 'paused');
  assert.equal(subject.ledger.get('a')?.route, undefined);
  assert.equal(subject.found.length, 0);
});

test('dense areas subdivide in place and continue with smaller views rather than becoming no-path', async () => {
  const runner = new BackgroundRunner((_call, _index, target) => ({ data: snapshot(target.zoom, target.zoom === 14 ? 'limited' : 'ready') }));
  const subject = setup([connection('a')], { background: runner, client: new TestClient(() => ({ route: road })) });
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('a')?.state, 'ready');
  assert.equal(subject.ledger.get('a')?.areas.length, 4);
  assert.equal((runner.calls[1].targets[0] as TripArea).zoom, 15);
  assert.equal(subject.ledger.get('a')?.nextArea, 1);
});

test('an oversized coarse overview does not explode into fine tiles or block the detailed endpoint attempt', async () => {
  const regional = connection('regional', [area(0, 6), area(1, 14)]); regional.to = [116.4, 34];
  const runner = new BackgroundRunner((_call, index, target) => ({ data: snapshot(index, target.zoom < 14 ? 'limited' : 'ready') }));
  const subject = setup([regional], { background: runner });
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('regional')?.areas.length, 2);
  assert.equal(subject.ledger.get('regional')?.state, 'unavailable');
  assert.equal(subject.background.calls.length, 1);
  assert.equal((subject.client as TestClient).calls.length, 1);
});

test('a working data limit automatically switches to small sections while other connections continue to completion', async () => {
  const runner = new BackgroundRunner((call) => ({ data: snapshot(call, call === 0 ? 'limited' : 'ready') }));
  const subject = setup([connection('dense', [area(0, 16)]), connection('nearby')], { background: runner, client: new TestClient(() => ({ route: road })) });
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('dense')?.state, 'ready');
  assert.match(subject.ledger.get('dense')?.reason ?? '', /verified local road sections/);
  assert.equal(subject.ledger.get('nearby')?.state, 'ready');
  assert.equal(subject.ledger.snapshot().percentRemaining, 0);
  assert.ok(subject.background.calls.some(call => call.options.roadLimits?.clipBounds));
  assert.ok(subject.progress.some(value => /Switching automatically/.test(value.message)));
});

test('aborting immediately after a saved section requeues the live task and resumes its prefix without a reload', async () => {
  const part = connection('split'); part.to = [114.012, 22];
  const client: RoutingClient = {
    cancel() {},
    async route(_snapshot, legs, gate) {
      return { id: 0, routes: legs.map(leg => ({ coordinates: [leg.from, leg.to], distance: 100 })),
        stats: { nodes: 4, edges: 3, truncated: false },
        ...(gate ? { portals: [{ point: gate.center, grade: 'ground|0|0', bearing: 0 }] } : {}) };
    },
  };
  const first = setup([part], { client });
  first.ledger.start(part.key);
  first.ledger.setSplit(part.key, { version: 1, pass: 0, nextPart: 0, totalParts: 0, frontier: [] });
  first.ledger.requeue(part.key);
  first.configuration.onProgress = value => { if (/Smaller sections saved: 1\//.test(value.message)) first.controller.abort(); };
  await assert.rejects(processTripQueue(first.configuration), /paused/);
  assert.equal(first.ledger.status(part.key)?.state, 'queued');
  assert.equal(first.ledger.get(part.key)?.split?.nextPart, 1);
  const second = setup([part], { ledger: first.ledger, client });
  await processTripQueue(second.configuration);
  assert.equal(second.ledger.status(part.key)?.state, 'ready');
  assert.ok(second.found[0].route.coordinates.length >= 4);
  assert.equal(second.ledger.snapshot().percentRemaining, 0);
});

test('unsolved regional detail is unavailable, not a false claim that no real path exists', async () => {
  const regional = connection('regional'); regional.to = [116.4, 34];
  const subject = setup([regional]);
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('regional')?.state, 'unavailable');
  assert.match(subject.ledger.get('regional')?.reason ?? '', /regional|coarse/i);
  assert.equal(subject.ledger.snapshot().noPath, 0);
});

test('complete fine data without a route is no-path, while absent or timed-out detail is unavailable', async () => {
  const subject = setup([connection('fine')]);
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('fine')?.state, 'no-path');
  const empty = setup([connection('empty')], { background: new BackgroundRunner((_call, index) => ({ data: snapshot(index, 'empty') })) });
  await processTripQueue(empty.configuration);
  assert.equal(empty.ledger.get('empty')?.state, 'unavailable');
  const timedOut = setup([connection('wait')], { background: new BackgroundRunner((_call, index) => ({ data: snapshot(index), waitTimedOut: true })) });
  await processTripQueue(timedOut.configuration);
  assert.equal(timedOut.ledger.get('wait')?.state, 'unavailable');
});

test('truncated graphs and evicted roads try finite section searches instead of pausing or claiming no path', async () => {
  const graph = setup([connection('graph')], { client: new TestClient(() => ({ route: null, truncated: true })) });
  await processTripQueue(graph.configuration);
  assert.equal(graph.ledger.get('graph')?.state, 'unavailable');
  assert.ok(graph.background.calls.some(call => call.options.roadLimits?.clipBounds));
  const eviction = setup([connection('memory', [area(0), area(1)])], {
    profile: profile({ maxRoadFeatures: 1 }),
    background: new BackgroundRunner((_call, index) => ({ data: snapshot(index, 'ready', [feature(index / 100)]) })),
  });
  await processTripQueue(eviction.configuration);
  assert.equal(eviction.ledger.get('memory')?.state, 'unavailable');
  assert.match(eviction.ledger.get('memory')?.reason ?? '', /Automatic section searches/);
  assert.equal(eviction.ledger.snapshot().paused, 0);
  assert.equal(eviction.ledger.snapshot().noPath, 0);
});

test('an expired chunk deadline with a completed prefix continues the remaining connection areas', async () => {
  const subject = setup([connection('a', [area(0), area(1), area(2)])]);
  const normal = subject.background.run;
  let calls = 0;
  subject.configuration.run = async (original, targets, options) => {
    const first = calls++ === 0;
    const result = await normal(original, first ? targets.slice(0, 1) : targets, options);
    return { ...result, total: targets.length, timedOut: first };
  };
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('a')?.state, 'no-path');
  assert.equal(subject.ledger.get('a')?.nextArea, 3);
  assert.deepEqual(subject.background.calls.map(call => (call.targets[0] as TripArea).center), [[114, 22], [114.001, 22]]);
});

test('a chunk making no progress pauses explicitly and preserves the remaining work', async () => {
  const subject = setup();
  subject.configuration.run = async (_original, targets) => ({ completed: 0, total: targets.length, ready: 0, timedOut: true });
  await processTripQueue(subject.configuration);
  assert.equal(subject.ledger.get('a')?.state, 'paused');
  assert.equal(subject.ledger.get('a')?.nextArea, 0);
  assert.equal(subject.ledger.snapshot().percentRemaining, 100);
});

test('the shared serial queue interleaves cooperative chunks from two maps without overlapping temporary maps', async () => {
  const serial = new PreparationQueue(), order: string[] = [];
  let active = 0, peak = 0, releaseFirst!: () => void;
  const gate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const makeRun = (label: string): typeof prepareBackgroundRoads => async (_original, targets, options) => {
    active++; peak = Math.max(peak, active); order.push(label);
    if (order.length === 1) await gate;
    let completed = 0;
    for (const [index, input] of targets.entries()) {
      const target = input as TripArea;
      await options.onSnapshot(snapshot(index), options.signal!, { index, target, waitTimedOut: false }); completed++;
    }
    active--;
    return { completed, total: targets.length, ready: completed, timedOut: false };
  };
  const a = setup([connection('a', [area(0), area(1), area(2), area(3)])], { serial });
  const b = setup([connection('b', [area(0), area(1), area(2), area(3)])], { serial });
  a.configuration.run = makeRun('a'); b.configuration.run = makeRun('b');
  const first = processTripQueue(a.configuration), second = processTripQueue(b.configuration);
  releaseFirst(); await Promise.all([first, second]);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['a', 'b', 'a', 'b']);
  assert.equal(a.ledger.snapshot().processed, 1); assert.equal(b.ledger.snapshot().processed, 1);
});

test('pauses abort immediately without leaving a long timer behind', async () => {
  const controller = new AbortController(), waiting = tripPause(10000, controller.signal);
  controller.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  await assert.rejects(tripPause(0, controller.signal), { name: 'AbortError' });
});

test('connections beyond the configured distance become direct without creating a map, worker or pause', async () => {
  const long = connection('long'); long.to = [116.4, 34];
  const subject = setup([long], { profile: profile({ pauseMs: 60000 }) });
  subject.configuration.maxDistanceKm = 30;
  await processTripQueue(subject.configuration);
  assert.equal(subject.background.calls.length, 0);
  assert.equal((subject.client as TestClient).calls.length, 0);
  assert.equal(subject.ledger.get('long')?.state, 'direct');
  assert.equal(subject.ledger.get('long')?.nextArea, 0);
  assert.equal(subject.ledger.snapshot().direct, 1);
  assert.equal(subject.ledger.snapshot().eligible, 0);
  assert.equal(subject.ledger.snapshot().processed, 0);
  assert.equal(subject.ledger.snapshot().ready, 0);
  assert.equal(subject.ledger.snapshot().percentRemaining, 0);
  assert.match(subject.ledger.get('long')?.reason ?? '', /30 km/);
});

test('distance skips do not stop short connections in the same itinerary', async () => {
  const long = connection('long'); long.to = [116.4, 34];
  const subject = setup([long, connection('short')], { client: new TestClient(() => ({ route: road })) });
  subject.configuration.maxDistanceKm = 30;
  await processTripQueue(subject.configuration);
  assert.equal(subject.background.calls.length, 1);
  assert.equal((subject.client as TestClient).calls.length, 1);
  assert.equal(subject.ledger.get('long')?.state, 'direct');
  assert.equal(subject.ledger.get('short')?.state, 'ready');
  assert.equal(subject.ledger.snapshot().direct, 1);
  assert.equal(subject.ledger.snapshot().ready, 1);
  assert.equal(subject.ledger.snapshot().eligible, 1);
  assert.equal(subject.ledger.snapshot().processed, 1);
});

test('an optional unlimited distance setting retains regional attempts for existing processor callers', async () => {
  for (const limit of [undefined, null, 0]) {
    const long = connection('long'); long.to = [116.4, 34];
    const subject = setup([long]); subject.configuration.maxDistanceKm = limit;
    await processTripQueue(subject.configuration);
    assert.equal(subject.background.calls.length, 1);
    assert.equal(subject.ledger.get('long')?.state, 'unavailable');
    assert.equal(subject.ledger.snapshot().direct, 0);
  }
});

test('a distance policy changed while waiting for the shared queue prevents any new road loading', async () => {
  const serial = new PreparationQueue(), gateController = new AbortController();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const previous = serial.run(gateController.signal, () => gate);
  const long = connection('long'); long.to = [116.4, 34];
  const subject = setup([long], { serial }); let limit = 2000;
  subject.configuration.maxDistanceKm = () => limit;
  const operation = processTripQueue(subject.configuration);
  await flush();
  assert.equal(subject.ledger.get('long')?.state, 'preparing');
  limit = 30; release(); await previous; await operation;
  assert.equal(subject.background.calls.length, 0);
  assert.equal((subject.client as TestClient).calls.length, 0);
  assert.equal(subject.ledger.get('long')?.state, 'direct');
});

test('lowering the distance while a worker is active cannot replace the direct line with a late path', async () => {
  const client = new DeferredClient();
  const long = connection('long'); long.to = [116.4, 34];
  const subject = setup([long], { client }); let limit = 2000;
  subject.configuration.maxDistanceKm = () => limit;
  const operation = processTripQueue(subject.configuration);
  await flush(); assert.equal(client.calls.length, 1);
  limit = 30; client.finish(0, road); await operation;
  assert.equal(subject.ledger.get('long')?.state, 'direct');
  assert.equal(subject.ledger.get('long')?.route, undefined);
  assert.equal(subject.found.length, 0);
});
