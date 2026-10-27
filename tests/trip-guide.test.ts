import assert from 'node:assert/strict';
import test from 'node:test';
import { findTripGuide, guidedTripWindow } from '../src/trip-guide';
import { buildRoadGraph, roadDistance, type RoadCoordinate, type RoadFeature, type RoadRoute } from '../src/road-graph';
import { clipRoadFeature } from '../src/road-clipping';
import { TripQueue } from '../src/trip-queue';
import { PreparationQueue } from '../src/auto-preparation';
import { workloadProfile, type WorkloadProfile } from '../src/workload-settings';
import type { TripProcessorOptions, TripProcessorProgress } from '../src/trip-processor';
import type { RoutingClient } from '../src/local-routing-client';
import type { RoutingJob, RoutingResult } from '../src/routing-protocol';
import type { RoadSnapshot } from '../src/local-roads';
import type { BackgroundRoadPreparationOptions, RoadPreparationTarget, prepareBackgroundRoads } from '../src/background-roads';
import type { MapLike } from '../src/contracts';

const EARTH = 6371008.8, RAD = Math.PI / 180, WORLD = 2 * Math.PI * EARTH;
const point = (x: number, y = 0): RoadCoordinate => [x / EARTH / RAD, y / EARTH / RAD];
const length = (coordinates: RoadCoordinate[]): number => coordinates.slice(1).reduce((sum, coordinate, index) => sum + roadDistance(coordinates[index], coordinate), 0);
const route = (coordinates: RoadCoordinate[]): RoadRoute => ({ coordinates, distance: length(coordinates) });
const detour = (height = 1500): RoadRoute => route([point(0), point(-400), point(-400, height), point(1600, height), point(1600), point(1200)]);
const road = (path: RoadRoute): RoadFeature => ({ geometry: { type: 'LineString', coordinates: path.coordinates }, properties: { class: 'minor' } });
const flush = async (): Promise<void> => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

class GraphClient implements RoutingClient {
  calls: Array<{ snapshot: RoadSnapshot; legs: RoutingJob['legs'] }> = [];
  cancellations = 0;
  timeouts: number[] = [];
  async route(snapshot: RoadSnapshot, legs: RoutingJob['legs']): Promise<RoutingResult> {
    this.calls.push({ snapshot, legs: structuredClone(legs) });
    const graph = buildRoadGraph(snapshot.features);
    return { id: this.calls.length, stats: graph.stats, routes: legs.map(leg => graph.route(leg.from, leg.to, leg.maxSnapMeters ?? 100, { from: leg.fromAnchor, to: leg.toAnchor })) };
  }
  configure(timeout: number): void { this.timeouts.push(timeout); }
  cancel(): void { this.cancellations++; }
}

function setup(input: { roads?: RoadRoute[]; from?: RoadCoordinate; to?: RoadCoordinate; profile?: Partial<WorkloadProfile>; waitTimedOut?: boolean } = {}) {
  const from = input.from ?? point(0), to = input.to ?? point(1200);
  const ledger = new TripQueue(); ledger.reconcile([{ key: 'trip', from, to, areas: [] }]); ledger.start('trip');
  const client = new GraphClient(), controller = new AbortController(), serial = new PreparationQueue();
  const profile = { ...workloadProfile({ mode: 'maximum', pauseMs: 0 }), ...input.profile };
  const calls: Array<{ target: RoadPreparationTarget; options: BackgroundRoadPreparationOptions }> = [];
  const progress: TripProcessorProgress[] = [], found: RoadRoute[] = [];
  const roads = input.roads ?? [detour()];
  const run: typeof prepareBackgroundRoads = async (_original, targets, options) => {
    assert.equal(targets.length, 1);
    const target = targets[0] as RoadPreparationTarget;
    const index = calls.length; calls.push({ target, options });
    const features = [road(roads[Math.min(index, roads.length - 1)])].flatMap(feature => {
      const clipped = clipRoadFeature(feature, options.roadLimits!.clipBounds!); return clipped ? [clipped] : [];
    });
    await options.onSnapshot({ key: `guide-${index}`, sources: ['transport'], state: 'ready', features }, options.signal!, { index: 0, target, waitTimedOut: input.waitTimedOut ?? false });
    return { completed: 1, total: 1, ready: 1, timedOut: input.waitTimedOut ?? false };
  };
  const options: TripProcessorOptions = {
    original: {} as MapLike, keys: ['trip'], ledger, client, serial, signal: controller.signal,
    profile: () => profile, run, factory: () => { throw Error('Guide tests must not allocate a real map.'); },
    visible: () => true, onProgress: value => progress.push(value), onRoute: (_key, result) => found.push(result),
  };
  return { from, to, ledger, client, controller, serial, profile, calls, progress, found, options };
}

test('guided windows follow a curved backtracking route far outside its direct corridor with local gate tangents', () => {
  const guide = detour();
  assert.ok(guide.distance > 5000);
  for (let pass = 0; pass < 3; pass++) {
    const first = guidedTripWindow(guide, pass, 0);
    assert.equal(first.zoom, pass === 2 ? 14 : 15);
    assert.ok(first.to[0] < first.from[0], 'The route initially backtracks instead of following the global endpoint direction.');
    assert.ok(first.gateTo[0] < first.gateFrom[0]);
    let high = false, vertical = false;
    for (let index = 0; index < first.total; index++) {
      const window = guidedTripWindow(guide, pass, index);
      assert.equal(window.zoom, first.zoom);
      assert.equal(window.total, first.total);
      assert.ok(roadDistance(window.from, window.to) <= (pass === 0 ? 350 : pass === 1 ? 250 : 200) + 0.01);
      high ||= roadDistance([window.center[0], 0], window.center) > 1000;
      vertical ||= Math.abs(window.gateFrom[0] - window.gateTo[0]) < 1e-10 && Math.abs(window.gateFrom[1] - window.gateTo[1]) > 1e-8;
      if (index + 1 < first.total) {
        const next = guidedTripWindow(guide, pass, index + 1);
        assert.ok(roadDistance(window.to, next.from) < 0.001);
        assert.ok(window.bounds.east >= next.bounds.west && next.bounds.east >= window.bounds.west);
        assert.ok(window.bounds.north >= next.bounds.south && next.bounds.north >= window.bounds.south);
      }
    }
    assert.equal(high, true);
    assert.equal(vertical, true);
    const last = guidedTripWindow(guide, pass, first.total - 1);
    assert.ok(roadDistance(last.to, guide.coordinates.at(-1)!) < 0.001);
  }
});

test('fixed-detail guided windows fit the Eco viewport at high latitudes and retain short date-line crossings', () => {
  for (const latitude of [0, 80, -80]) for (let pass = 0; pass < 3; pass++) {
    const guide = route([[-10, latitude], [-9.99, latitude + 0.001], [-9.98, latitude]]);
    const first = guidedTripWindow(guide, pass, 0);
    for (let index = 0; index < first.total; index++) {
      const window = guidedTripWindow(guide, pass, index);
      const scale = 512 * 2 ** window.zoom / WORLD;
      const mercator = (value: number): number => EARTH * Math.log(Math.tan(Math.PI / 4 + value * RAD / 2));
      const pixelsX = (window.bounds.east - window.bounds.west) * RAD * EARTH * scale;
      const pixelsY = (mercator(window.bounds.north) - mercator(window.bounds.south)) * scale;
      assert.ok(pixelsX <= 768 && pixelsY <= 512, `Window exceeds Eco viewport at ${latitude} degrees: ${pixelsX}×${pixelsY}.`);
      assert.ok(window.zoom >= 14);
    }
  }
  const guide = route([[179.995, 0], [179.998, 0.01], [-179.998, 0.01], [-179.995, 0]]);
  const first = guidedTripWindow(guide, 0, 0);
  for (let index = 0; index < first.total; index++) {
    const window = guidedTripWindow(guide, 0, index);
    assert.ok(window.bounds.east - window.bounds.west < 0.03);
    assert.ok(Math.abs(window.center[0]) > 179);
  }
  assert.ok(roadDistance(guidedTripWindow(guide, 0, first.total - 1).to, [-179.995, 0]) < 0.001);
  assert.throws(() => guidedTripWindow({ distance: 0, coordinates: [[NaN, 0], [0, 0]] }, 0, 0), /Invalid/);
});

test('bounded guide fetching uses actual road detours, selects the shorter guide, and never completes the task', async () => {
  const subject = setup({ roads: [detour(1500), detour(1300)], from: point(0, 160), to: point(1200, 160), waitTimedOut: true });
  const guide = await findTripGuide(subject.options, 'trip', () => true);
  assert.ok(guide);
  assert.ok(guide.distance > 5500 && guide.distance < 5800);
  assert.ok(Math.abs(guide.distance - length(guide.coordinates)) < 1e-9);
  assert.ok(roadDistance(guide.coordinates[0], subject.from) < 0.001);
  assert.ok(roadDistance(guide.coordinates.at(-1)!, subject.to) < 0.001);
  assert.ok(Math.abs(Math.max(...guide.coordinates.map(point => point[1])) * EARTH * RAD - 1300) < 0.01);
  assert.equal(subject.calls.length, 2);
  assert.equal(subject.client.calls.length, 2);
  assert.equal(subject.client.cancellations, 2);
  assert.deepEqual(subject.client.timeouts, [8000, 8000]);
  assert.ok(subject.calls.every(call => call.options.viewportWidth === 768 && call.options.viewportHeight === 512 && call.options.tileCacheSize === 8));
  assert.ok(subject.calls.every(call => call.options.roadLimits?.maxFeatures === 6000 && call.options.roadLimits?.maxPositions === 50000));
  assert.ok(subject.calls[0].target.zoom! <= 14 && subject.calls[1].target.zoom! <= 16);
  assert.ok(subject.calls[1].target.zoom! > subject.calls[0].target.zoom!);
  assert.ok(subject.client.calls.every(call => call.legs.length === 1 && call.legs[0].maxSnapMeters === 1000));
  assert.ok(subject.progress.every(value => value.message === 'Finding a walking detour guide…'));
  assert.equal(subject.ledger.get('trip')?.state, 'preparing');
  assert.equal(subject.ledger.get('trip')?.route, undefined);
  assert.equal(subject.ledger.get('trip')?.split, undefined);
  assert.equal(subject.found.length, 0);
});

test('guide attempts preserve smaller caller budgets and clip a date-line bbox without spanning the world', async () => {
  const from: RoadCoordinate = [179.995, 0], to: RoadCoordinate = [-179.995, 0];
  const subject = setup({ from, to, roads: [route([from, [180, 0.001], to])], profile: { maxRoadFeatures: 2, maxRoadPositions: 12, workerTimeoutMs: 3000 } });
  const guide = await findTripGuide(subject.options, 'trip', () => true);
  assert.ok(guide);
  assert.deepEqual(subject.client.timeouts, [3000, 3000]);
  for (const call of subject.calls) {
    assert.equal(call.options.roadLimits?.maxFeatures, 2);
    assert.equal(call.options.roadLimits?.maxPositions, 12);
    assert.ok(call.options.roadLimits!.clipBounds!.east - call.options.roadLimits!.clipBounds!.west < 0.1);
    assert.ok(Math.abs(call.target.center[0]) > 179);
  }
  assert.ok(guide.coordinates.every((coordinate, index) => !index || Math.abs(coordinate[0] - guide.coordinates[index - 1][0]) < 0.1));
});

test('invalid, out-of-window and excessively distant snapped routes cannot become guides', async () => {
  for (const candidate of [
    { distance: 1, coordinates: [[NaN, 0], point(1200)] },
    { distance: 1, coordinates: [point(0), point(0, 5000), point(1200)] },
    { distance: 1, coordinates: [point(-1500), point(1200)] },
  ] as RoadRoute[]) {
    const subject = setup();
    subject.client.route = async () => ({ id: 1, routes: [candidate], stats: { nodes: 2, edges: 1, truncated: false } });
    assert.equal(await findTripGuide(subject.options, 'trip', () => true), null);
    assert.equal(subject.ledger.get('trip')?.route, undefined);
    assert.equal(subject.found.length, 0);
  }
});

test('abort, user pause and endpoint edits reject late guide geometry without another attempt', async () => {
  for (const reason of ['abort', 'pause', 'edit'] as const) {
    const subject = setup();
    let resolve!: (result: RoutingResult) => void;
    let requested = 0;
    subject.client.route = async () => { requested++; return new Promise(accept => { resolve = accept; }); };
    const pending = findTripGuide(subject.options, 'trip', () => true);
    await flush();
    assert.equal(requested, 1);
    if (reason === 'abort') subject.controller.abort();
    if (reason === 'pause') subject.ledger.pause('trip', 'User paused.');
    if (reason === 'edit') subject.ledger.reconcile([{ key: 'trip', from: point(50), to: point(1200), areas: [] }]);
    resolve({ id: 1, routes: [detour()], stats: { nodes: 6, edges: 5, truncated: false } });
    assert.equal(await pending, null);
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.ledger.get('trip')?.route, undefined);
    assert.equal(subject.found.length, 0);
  }
});

test('a guide waiting in the shared queue allocates no loader when it becomes inactive', async () => {
  const subject = setup();
  let release!: () => void;
  const blocker = subject.serial.run(new AbortController().signal, () => new Promise<void>(resolve => { release = resolve; }));
  let active = true;
  const pending = findTripGuide(subject.options, 'trip', () => active);
  active = false; release();
  await blocker;
  assert.equal(await pending, null);
  assert.equal(subject.calls.length, 0);
  assert.equal(subject.client.calls.length, 0);
});

test('source generation and distance-policy changes reject a late guide through the current active guard', async () => {
  for (const reason of ['source', 'distance'] as const) {
    const subject = setup();
    let resolve!: (result: RoutingResult) => void;
    subject.client.route = async () => new Promise(accept => { resolve = accept; });
    let sourceGeneration = 0, maxDistanceKm = 30;
    const active = (): boolean => {
      if (sourceGeneration !== 0) return false;
      if (roadDistance(subject.from, subject.to) > maxDistanceKm * 1000) {
        subject.ledger.setDirect('trip'); return false;
      }
      return true;
    };
    const pending = findTripGuide(subject.options, 'trip', active);
    await flush();
    assert.equal(subject.calls.length, 1);
    if (reason === 'source') sourceGeneration++;
    else maxDistanceKm = 0.5;
    resolve({ id: 1, routes: [detour()], stats: { nodes: 6, edges: 5, truncated: false } });
    assert.equal(await pending, null);
    assert.equal(subject.calls.length, 1);
    assert.equal(subject.ledger.get('trip')?.state, reason === 'source' ? 'preparing' : 'direct');
    assert.equal(subject.ledger.get('trip')?.route, undefined);
    assert.equal(subject.found.length, 0);
  }
});

test('the pause between guide attempts aborts promptly and does not run the second loader', async () => {
  const subject = setup({ profile: { pauseMs: 60000 } });
  const pending = findTripGuide(subject.options, 'trip', () => true);
  await flush();
  assert.equal(subject.calls.length, 1);
  subject.controller.abort();
  assert.equal(await pending, null);
  assert.equal(subject.calls.length, 1);
  assert.equal(subject.found.length, 0);
});

test('a hidden view never fetches a guide and a late guide is discarded when visibility changes', async () => {
  const hidden = setup(); hidden.options.visible = () => false;
  assert.equal(await findTripGuide(hidden.options, 'trip', () => true), null);
  assert.equal(hidden.calls.length, 0);
  assert.equal(hidden.ledger.get('trip')?.state, 'preparing');
  const late = setup(); let visible = true;
  late.options.visible = () => visible;
  const route = late.client.route.bind(late.client);
  late.client.route = async (...args) => { const result = await route(...args); visible = false; return result; };
  assert.equal(await findTripGuide(late.options, 'trip', () => true), null);
  assert.equal(late.calls.length, 1);
  assert.equal(late.ledger.get('trip')?.state, 'preparing');
  assert.equal(late.ledger.get('trip')?.route, undefined);
  assert.equal(late.found.length, 0);
});
