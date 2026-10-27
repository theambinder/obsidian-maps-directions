import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSplitPath, processSplitTrip, splitTripWindow } from '../src/segmented-trip';
import { TripQueue, type TripConnection, type TripSplitPath } from '../src/trip-queue';
import { PreparationQueue } from '../src/auto-preparation';
import { buildRoadGraph, roadDistance, type RoadCoordinate, type RoadFeature, type RoadGraph, type RoadRoute } from '../src/road-graph';
import { clipRoadFeature } from '../src/road-clipping';
import type { RoadSnapshot } from '../src/local-roads';
import type { RoutingClient } from '../src/local-routing-client';
import type { RoutingJob, RoutingResult } from '../src/routing-protocol';
import type { TripProcessorOptions, TripProcessorProgress } from '../src/trip-processor';
import type { BackgroundRoadPreparationOptions, prepareBackgroundRoads, RoadPreparationTarget } from '../src/background-roads';
import { workloadProfile, type WorkloadProfile } from '../src/workload-settings';
import type { MapLike } from '../src/contracts';

const DEGREES_PER_METER = 180 / Math.PI / 6371008.8;
const point = (x: number, y = 0): RoadCoordinate => [x * DEGREES_PER_METER, y * DEGREES_PER_METER];
const road = (coordinates: RoadCoordinate[], properties: Record<string, unknown> = {}): RoadFeature => ({
  geometry: { type: 'LineString', coordinates }, properties: { class: 'minor', ...properties },
});
const mainRoad = (): RoadFeature => road(Array.from({ length: 181 }, (_, index) => point(-1500 + index * 25)));
const positions = (feature: RoadFeature): number => {
  const coordinates = feature.geometry?.coordinates as unknown[];
  return feature.geometry?.type === 'LineString' ? coordinates.length : coordinates.reduce<number>((sum, line) => sum + (line as unknown[]).length, 0);
};
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

/** Uses the production graph, gate discovery and strict anchors rather than returning invented paths. */
class GraphClient implements RoutingClient {
  graph: RoadGraph | null = null;
  key = '';
  builds = 0;
  cancellations = 0;
  timeouts: number[] = [];
  calls: Array<{ key: string; legs: RoutingJob['legs']; gate?: RoutingJob['gate']; nodes: number }> = [];
  onResult?: (result: RoutingResult, legs: RoutingJob['legs']) => void;
  truncated = false;
  async route(snapshot: RoadSnapshot, legs: RoutingJob['legs'], gate?: RoutingJob['gate']): Promise<RoutingResult> {
    if (!this.graph || this.key !== snapshot.key) { this.graph = buildRoadGraph(snapshot.features); this.key = snapshot.key; this.builds++; }
    this.calls.push({ key: snapshot.key, legs: structuredClone(legs), gate: gate && structuredClone(gate), nodes: this.graph.stats.nodes });
    const result: RoutingResult = {
      id: this.calls.length,
      routes: legs.map(leg => this.graph!.route(leg.from, leg.to, leg.maxSnapMeters ?? 100, { from: leg.fromAnchor, to: leg.toAnchor })),
      stats: { ...this.graph.stats, truncated: this.truncated || this.graph.stats.truncated },
      ...(gate ? { portals: this.graph.portals(gate) } : {}),
    };
    this.onResult?.(result, legs);
    return result;
  }
  cancel(): void { this.cancellations++; this.graph = null; this.key = ''; }
  configure(timeoutMs: number): void { this.timeouts.push(timeoutMs); }
}

/** Mimics loaded tile features being clipped before collection budgets are checked. */
class ClippedRunner {
  readonly calls: Array<{ target: RoadPreparationTarget; options: BackgroundRoadPreparationOptions; features: number; positions: number }> = [];
  active = 0;
  peakActive = 0;
  forcedState?: RoadSnapshot['state'];
  waitTimedOut = false;
  beforeSnapshot?: (call: number) => void;
  constructor(readonly roads: RoadFeature[]) {}
  readonly run: typeof prepareBackgroundRoads = async (_original, targets, options) => {
    assert.equal(targets.length, 1, 'Each split owns one bounded local window.');
    const target = targets[0] as RoadPreparationTarget;
    const bounds = options.roadLimits?.clipBounds;
    assert.ok(bounds, 'Road collection must clip tile features to the active window.');
    const clipped = this.roads.flatMap(feature => { const copy = clipRoadFeature(feature, bounds); return copy ? [copy] : []; });
    const count = clipped.reduce((sum, feature) => sum + positions(feature), 0);
    const limited = clipped.length > (options.roadLimits?.maxFeatures ?? Infinity) || count > (options.roadLimits?.maxPositions ?? Infinity);
    const state = this.forcedState ?? (limited ? 'limited' : clipped.length ? 'ready' : 'empty');
    const call = this.calls.length;
    this.calls.push({ target, options, features: clipped.length, positions: count });
    this.active++; this.peakActive = Math.max(this.peakActive, this.active);
    try {
      this.beforeSnapshot?.(call);
      const snapshot: RoadSnapshot = { key: `local-window-${call}`, state, sources: ['transport'], features: state === 'ready' ? clipped : [] };
      await options.onSnapshot(snapshot, options.signal!, { index: 0, target, waitTimedOut: this.waitTimedOut });
      return { completed: 1, total: 1, ready: state === 'ready' ? 1 : 0, timedOut: this.waitTimedOut };
    } finally { this.active--; }
  };
}

function setup(input: { roads?: RoadFeature[]; from?: RoadCoordinate; to?: RoadCoordinate; ledger?: TripQueue; pauseMs?: number; profile?: Partial<WorkloadProfile> } = {}) {
  const connection: TripConnection = { key: 'trip', from: input.from ?? point(0), to: input.to ?? point(1400), areas: [] };
  const ledger = input.ledger ?? new TripQueue(); ledger.reconcile([connection]); ledger.start('trip');
  const client = new GraphClient(), runner = new ClippedRunner(input.roads ?? [mainRoad()]), controller = new AbortController();
  const profile: WorkloadProfile = { ...workloadProfile({ mode: 'eco', pauseMs: input.pauseMs ?? 0 }), ...input.profile };
  const progress: TripProcessorProgress[] = [], found: RoadRoute[] = [];
  const options: TripProcessorOptions = {
    original: {} as MapLike, keys: ['trip'], ledger, client, serial: new PreparationQueue(), signal: controller.signal,
    profile: () => profile, visible: () => true, run: runner.run,
    factory: () => { throw Error('Synthetic tile loading must not create a real map.'); },
    onProgress: value => progress.push(value), onRoute: (_key, route) => found.push(route),
  };
  return { connection, ledger, client, runner, controller, profile, progress, found, options };
}

test('configured pin access can reach roads beyond 100 metres without adding invented road geometry or relaxing internal anchors', async () => {
  const from = point(0, 160), to = point(1400, 160);
  const rejected = setup({ from, to, profile: { maxAccessMeters: 100 } });
  await processSplitTrip(rejected.options, 'trip', () => true);
  assert.equal(rejected.ledger.status('trip')?.state, 'unavailable');
  const allowed = setup({ from, to, profile: { maxAccessMeters: 250 } });
  await processSplitTrip(allowed.options, 'trip', () => true);
  assert.equal(allowed.ledger.status('trip')?.state, 'ready');
  const route = allowed.found[0];
  assert.ok(roadDistance(from, route.coordinates[0]) > 150);
  assert.ok(roadDistance(to, route.coordinates[route.coordinates.length - 1]) > 150);
  assert.ok(route.coordinates.every(coordinate => Math.abs(coordinate[1]) < 1e-8));
  assert.ok(allowed.client.calls.filter(call => call.legs.length).every(call => call.legs.every(leg => leg.maxSnapMeters === 250)));
  assert.ok(allowed.client.calls.some(call => call.legs.some(leg => !!leg.fromAnchor && !!leg.toAnchor)));
});

test('overlapping windows stay small across all passes and take the short direction across the date line', () => {
  for (let pass = 0; pass < 3; pass++) {
    const first = splitTripWindow(point(0), point(20000), pass, 0);
    assert.ok(first.total > 40);
    const second = splitTripWindow(point(0), point(20000), pass, 1);
    assert.ok(roadDistance(first.to, second.from) < 0.001);
    assert.ok(first.bounds.east > second.bounds.west);
    assert.ok(first.zoom >= 13 && first.zoom <= 16);
    assert.ok(roadDistance(first.from, first.to) <= 451);
  }
  const first = splitTripWindow([179.995, 0], [-179.995, 0], 0, 0);
  assert.ok(first.total < 4);
  assert.ok(first.bounds.east - first.bounds.west < 0.02);
  const last = splitTripWindow([179.995, 0], [-179.995, 0], 0, first.total - 1);
  assert.ok(roadDistance(last.to, [-179.995, 0]) < 0.001);
});

test('a multi-window connected route is assembled from bounded real graphs and exact strict anchor joins', async () => {
  const branches = Array.from({ length: 23 }, (_, index) => road([point(-1500 + index * 200, -150), point(-1500 + index * 200, 150)]));
  const distant = Array.from({ length: 50 }, (_, index) => road([point(10000 + index * 100), point(10100 + index * 100)]));
  const subject = setup({ roads: [mainRoad(), ...branches, ...distant], profile: { maxRoadFeatures: 16, maxRoadPositions: 120 } });
  assert.ok(subject.runner.roads.reduce((sum, feature) => sum + positions(feature), 0) > subject.profile.maxRoadPositions);
  await processSplitTrip(subject.options, 'trip', () => true);
  const task = subject.ledger.get('trip')!;
  assert.equal(task.state, 'ready');
  assert.equal(task.split, undefined);
  assert.equal(subject.found.length, 1);
  assert.ok(roadDistance(task.route!.coordinates[0], point(0)) < 0.001);
  assert.ok(roadDistance(task.route!.coordinates.at(-1)!, point(1400)) < 0.001);
  assert.ok(Math.abs(task.route!.distance - 1400) < 0.1);
  assert.equal(subject.runner.calls.length, splitTripWindow(point(0), point(1400), 0, 0).total);
  assert.ok(subject.runner.calls.every(call => call.features <= 16 && call.positions <= 120));
  const continuations = subject.client.calls.flatMap(call => call.legs).filter(leg => leg.fromAnchor);
  assert.ok(continuations.length >= 3);
  assert.ok(continuations.every(leg => leg.fromAnchor!.grade === 'ground|0|0' && leg.fromAnchor!.bearing !== undefined && roadDistance(leg.from, leg.fromAnchor!.point) < 0.001));
  assert.equal(subject.client.builds, subject.runner.calls.length, 'Portal and path calls share only their current graph.');
  assert.equal(subject.client.graph, null);
  assert.ok(subject.client.cancellations >= subject.runner.calls.length);
  assert.equal(subject.runner.peakActive, 1);
});

test('a real detour outside the first corridor is found by the next wider automatic pass', async () => {
  const subject = setup({ roads: [road([point(0), point(0, 500), point(1400, 500), point(1400)])] });
  await processSplitTrip(subject.options, 'trip', () => true);
  assert.equal(subject.ledger.get('trip')?.state, 'ready');
  assert.ok(Math.abs(subject.found[0].distance - 2400) < 0.1);
  assert.ok(subject.progress.some(value => value.message.includes('wider corridor')));
  assert.ok(subject.progress.some(value => value.message.includes('attempt 2/3')));
  assert.ok(subject.progress.every(value => !value.message.includes('attempt 3/3')));
  assert.equal(subject.client.graph, null);
});

test('keeping alternative reachable portals avoids getting stuck on the nearest dead-end road', async () => {
  const subject = setup({ roads: [road([point(0), point(900)]), road([point(0), point(0, 100), point(1400, 100), point(1400)])] });
  let largestFrontier = 0;
  const report = subject.options.onProgress!;
  subject.options.onProgress = progress => {
    report(progress); largestFrontier = Math.max(largestFrontier, subject.ledger.get('trip')?.split?.frontier.length ?? 0);
  };
  await processSplitTrip(subject.options, 'trip', () => true);
  assert.equal(subject.ledger.get('trip')?.state, 'ready');
  assert.ok(largestFrontier >= 2);
  assert.ok(Math.abs(subject.found[0].distance - 1600) < 0.1);
  assert.ok(subject.progress.every(value => !value.message.includes('wider corridor')));
});

test('grade-disconnected roads meeting at a section boundary never become an invented continuous route', async () => {
  const subject = setup({ to: point(1200), roads: [
    road([point(-200), point(600)]),
    road([point(600, -400), point(600), point(1600)], { brunnel: 'bridge', layer: 1 }),
  ] });
  await processSplitTrip(subject.options, 'trip', () => true);
  assert.equal(subject.ledger.get('trip')?.state, 'unavailable');
  assert.equal(subject.ledger.get('trip')?.route, undefined);
  assert.equal(subject.ledger.get('trip')?.split, undefined);
  assert.equal(subject.found.length, 0);
  assert.match(subject.ledger.get('trip')?.reason ?? '', /not proof that no path exists/);
  assert.ok(subject.progress.some(value => value.message.includes('wider corridor')));
  assert.ok(subject.runner.calls.length < 40, 'Three finite strategies finish rather than spinning on the same resource pause.');
});

test('artificial clipping endpoints cannot turn a surface dead end beneath a bridge into a junction', async () => {
  const roads = [road([point(0, 200), point(600)]), road([point(-500), point(1600)], { brunnel: 'bridge', layer: 1 })];
  assert.equal(buildRoadGraph(roads).route(point(0, 200), point(1400)), null);
  const subject = setup({ from: point(0, 200), to: point(1400), roads, profile: { maxAccessMeters: 100 } });
  await processSplitTrip(subject.options, 'trip', () => true);
  assert.equal(subject.ledger.get('trip')?.state, 'unavailable');
  assert.equal(subject.found.length, 0);
});

test('partial paths survive abort, reload and resume without reloading the already completed section prefix', async () => {
  const subject = setup();
  const onProgress = subject.options.onProgress!;
  subject.options.onProgress = progress => {
    onProgress(progress);
    if (progress.message.startsWith('Smaller sections saved: 2/')) subject.controller.abort();
  };
  await processSplitTrip(subject.options, 'trip', () => true);
  const partial = subject.ledger.get('trip')?.split;
  assert.equal(partial?.nextPart, 2);
  assert.ok(partial!.frontier.length > 0);
  assert.equal(subject.runner.calls.length, 2);
  assert.equal(subject.found.length, 0);
  const resumed = setup({ ledger: new TripQueue(JSON.parse(JSON.stringify(subject.ledger.serialize()))) });
  await processSplitTrip(resumed.options, 'trip', () => true);
  assert.equal(resumed.ledger.get('trip')?.state, 'ready');
  assert.equal(resumed.runner.calls.length, partial!.totalParts - 2);
  const firstContinuation = resumed.client.calls.flatMap(call => call.legs).find(leg => leg.fromAnchor)!;
  assert.deepEqual(firstContinuation.fromAnchor, partial!.frontier[0].anchor);
  const savedPrefix = partial!.frontier[0].route.coordinates;
  assert.deepEqual(resumed.found[0].coordinates.slice(0, savedPrefix.length), savedPrefix);
  assert.equal(resumed.client.graph, null);
});

test('an obsolete source calculation or distance policy change cannot commit a late path', async () => {
  for (const cancel of ['source', 'distance', 'user'] as const) {
    const subject = setup({ to: point(300) });
    let allowed = true;
    subject.client.onResult = (_result, legs) => {
      if (!legs.length) return;
      if (cancel === 'source') subject.controller.abort();
      else if (cancel === 'distance') { allowed = false; subject.ledger.setDirect('trip'); }
      else subject.ledger.pause('trip', 'User paused.');
    };
    try { await processSplitTrip(subject.options, 'trip', () => allowed); }
    catch { assert.equal(subject.controller.signal.aborted, true); }
    await flush();
    assert.equal(subject.found.length, 0);
    assert.equal(subject.ledger.get('trip')?.route, undefined);
    assert.notEqual(subject.ledger.get('trip')?.state, 'ready');
    if (cancel === 'distance') assert.equal(subject.ledger.get('trip')?.state, 'direct');
    if (cancel === 'user') assert.equal(subject.ledger.get('trip')?.state, 'paused');
    assert.equal(subject.client.graph, null);
  }
});

test('missing, limited, timed-out and graph-truncated corridors finish as unavailable after finite automatic attempts', async () => {
  for (const failure of ['empty', 'limited', 'timed-out', 'truncated'] as const) {
    const subject = setup();
    if (failure === 'empty' || failure === 'limited') subject.runner.forcedState = failure;
    if (failure === 'timed-out') {
      subject.runner.waitTimedOut = true;
      subject.client.onResult = result => { result.routes = result.routes.map(() => null); result.portals = []; };
    }
    if (failure === 'truncated') {
      subject.client.truncated = true;
      subject.client.onResult = result => { result.routes = result.routes.map(() => null); result.portals = []; };
    }
    await processSplitTrip(subject.options, 'trip', () => true);
    assert.equal(subject.ledger.get('trip')?.state, 'unavailable', failure);
    assert.equal(subject.ledger.snapshot().paused, 0);
    assert.equal(subject.runner.calls.length, 6, 'Two loading attempts for each of three corridor passes.');
    assert.equal(subject.found.length, 0);
    assert.equal(subject.client.graph, null);
  }
});

test('a verified connected path remains usable when unrelated tiles time out or graph data reaches its construction budget', async () => {
  const subject = setup();
  subject.client.truncated = true;
  subject.runner.waitTimedOut = true;
  await processSplitTrip(subject.options, 'trip', () => true);
  assert.equal(subject.ledger.status('trip')?.state, 'ready');
  assert.equal(subject.found.length, 1);
  assert.ok(subject.found[0].coordinates.every(coordinate => Math.abs(coordinate[1]) < 1e-8));
});

test('a transient missing map area is retried automatically without restarting successful sections', async () => {
  const subject = setup();
  subject.options.run = async (original, targets, options) => {
    subject.runner.forcedState = subject.runner.calls.length === 0 ? 'empty' : undefined;
    return subject.runner.run(original, targets, options);
  };
  await processSplitTrip(subject.options, 'trip', () => true);
  assert.equal(subject.ledger.get('trip')?.state, 'ready');
  assert.equal(subject.runner.calls.length, splitTripWindow(point(0), point(1400), 0, 0).total + 1);
  assert.ok(subject.progress.every(value => !value.message.includes('wider corridor')));
});

test('Eco waits between successful sections and releases each worker graph before its pause', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const subject = setup({ pauseMs: 1000 });
  const operation = processSplitTrip(subject.options, 'trip', () => true);
  await flush();
  assert.equal(subject.runner.calls.length, 1);
  assert.equal(subject.ledger.get('trip')?.split?.nextPart, 1);
  assert.equal(subject.client.graph, null);
  context.mock.timers.tick(999); await flush();
  assert.equal(subject.runner.calls.length, 1);
  context.mock.timers.tick(1); await flush();
  assert.equal(subject.runner.calls.length, 2);
  assert.equal(subject.client.graph, null);
  for (let index = 0; index < 8 && subject.ledger.get('trip')?.state !== 'ready'; index++) { context.mock.timers.tick(1000); await flush(); }
  await operation;
  assert.equal(subject.ledger.get('trip')?.state, 'ready');
  assert.ok(subject.client.timeouts.every(value => value === subject.profile.workerTimeoutMs));
  assert.equal(subject.runner.peakActive, 1);
});

test('path appending refuses disconnected seams and preserves short date-line geometry', () => {
  const prefix: TripSplitPath = { anchor: { point: [-180, 0], grade: 'ground|0|0', bearing: 0 },
    route: { coordinates: [[179.999, 0], [180, 0]], distance: 100 } };
  const next: RoadRoute = { coordinates: [[-180, 0], [-179.999, 0]], distance: 110 };
  const joined = appendSplitPath(prefix, next)!;
  assert.equal(joined.distance, 210);
  assert.deepEqual(joined.coordinates.slice(0, 2), [[179.999, 0], [180, 0]]);
  assert.ok(Math.abs(joined.coordinates[2][0] - 180.001) < 1e-10);
  assert.equal(appendSplitPath(prefix, { ...next, coordinates: [[-179.999, 0], [-179.998, 0]] }), null);
  assert.equal(appendSplitPath(null, next, { point: [-179.998, 0], grade: 'ground|0|0' }), null);
  assert.equal(appendSplitPath(null, { ...next, distance: NaN }), null);
  next.coordinates[0][0] = 0;
  assert.equal(joined.coordinates[1][0], 180);
});
