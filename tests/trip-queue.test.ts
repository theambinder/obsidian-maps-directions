import assert from 'node:assert/strict';
import test from 'node:test';
import { TripQueue, tripConnectionKey, planTripConnection, subdivideTripArea, type TripArea, type TripConnection, type TripSplitProgress, exceedsRoadDistance } from '../src/trip-queue';
import { roadDistance, type RoadRoute } from '../src/road-graph';

const areas: TripArea[] = [
  { center: [114, 22], zoom: 14, stage: 'endpoint' },
  { center: [114.01, 22], zoom: 14, stage: 'corridor' },
];
function connection(key: string): TripConnection { return { key, from: [114, 22], to: [114.01, 22], areas: areas.map(area => ({ ...area, center: [...area.center] })) }; }
const route: RoadRoute = { coordinates: [[114, 22], [114.005, 22.001], [114.01, 22]], distance: 1200 };
const splitProgress = (): TripSplitProgress => ({ version: 1, pass: 1, nextPart: 2, totalParts: 4,
  frontier: [{ anchor: { point: [114.01, 22], grade: 'ground|0|0' }, route: structuredClone(route) }] });

test('connection identity normalizes longitude, preserves direction and changes with the source', () => {
  const a = tripConnectionKey([180.01, 22], [179.99, 22], 'https://source.example/private-token');
  assert.equal(a, tripConnectionKey([-179.99, 22], [179.99, 22], 'https://source.example/private-token'));
  assert.notEqual(a, tripConnectionKey([179.99, 22], [-179.99, 22], 'https://source.example/private-token'));
  assert.notEqual(a, tripConnectionKey([-179.99, 22], [179.99, 22], 'another source'));
  assert.doesNotMatch(a, /source|token|179|22/);
});

test('the itinerary accepts every connection beyond the former 200 and 500 task limits', () => {
  const queue = new TripQueue();
  const input = Array.from({ length: 1200 }, (_, index) => connection(`task-${index}`));
  assert.equal(queue.reconcile(input).length, 1200);
  assert.equal(queue.snapshot().total, 1200);
  assert.equal(queue.serialize().tasks.length, 1200);
  assert.equal(queue.next(['task-1199'])?.key, 'task-1199');
});

test('optional short-first scheduling gives nearby work priority without changing selection scope or paused states', () => {
  const queue = new TripQueue();
  queue.reconcile([
    { ...connection('long'), to: [114.2, 22] },
    connection('nearby'), connection('tie'),
    { ...connection('hidden'), to: [114.001, 22] },
  ]);
  assert.equal(queue.next(['long', 'nearby', 'tie'])?.key, 'long');
  assert.equal(queue.next(['long', 'nearby', 'tie'], true)?.key, 'nearby');
  queue.pause('nearby', 'User paused.');
  assert.equal(queue.next(['long', 'nearby', 'tie'], true)?.key, 'tie');
  queue.finish('tie', 'unavailable');
  assert.equal(queue.next(['long', 'nearby', 'tie'], true)?.key, 'long');
  assert.equal(queue.status('nearby')?.state, 'paused');
});

test('reconciling a view preserves completed work and tasks belonging to other views', () => {
  const queue = new TripQueue();
  queue.reconcile([connection('a'), connection('b')]);
  queue.finish('a', 'ready', undefined, route);
  queue.reconcile([connection('c')]);
  assert.equal(queue.get('a')?.state, 'ready');
  assert.equal(queue.snapshot().total, 3);
  assert.equal(queue.snapshot(['c', 'c', 'missing']).total, 1);
  assert.equal(queue.next(['b', 'a'])?.key, 'b');
  assert.equal(queue.next(['a']), null);
  const edited = connection('a'); edited.to = [114.02, 22];
  queue.reconcile([edited]);
  assert.equal(queue.get('a')?.state, 'queued');
  assert.equal(queue.get('a')?.route, undefined);
});

test('progress counts finished attempts separately from found routes and leaves paused work unfinished', () => {
  const queue = new TripQueue(); queue.reconcile(['a', 'b', 'c', 'd'].map(connection));
  queue.finish('a', 'ready', undefined, route);
  queue.finish('b', 'no-path', 'No connected path in prepared detail.');
  queue.finish('c', 'unavailable', 'Network data unavailable.');
  queue.pause('d', 'Working data limit reached.');
  assert.deepEqual(queue.snapshot(), {
    total: 4, processed: 3, ready: 1, noPath: 1, unavailable: 1, paused: 1, queued: 0,
    preparing: 0, percentComplete: 75, percentRemaining: 25, areasProcessed: 0, areasTotal: 8, direct: 0, eligible: 4,
  });
  assert.equal(new TripQueue().snapshot().percentRemaining, 0);
});

test('a large itinerary never rounds unfinished eligible work to 100 percent', () => {
  const queue = new TripQueue();
  queue.reconcile(Array.from({ length: 3002 }, (_, index) => connection(`task-${index}`)));
  for (let index = 0; index < 3000; index++) queue.finish(`task-${index}`, index % 2 ? 'no-path' : 'unavailable');
  queue.setDirect('task-3001');
  for (const state of ['queued', 'preparing', 'paused'] as const) {
    if (state === 'preparing') queue.start('task-3000');
    if (state === 'paused') queue.pause('task-3000', 'User paused.');
    const progress = queue.snapshot();
    assert.equal(queue.get('task-3000')?.state, state);
    assert.equal(progress.total, 3002);
    assert.equal(progress.eligible, 3001);
    assert.equal(progress.processed, 3000);
    assert.equal(progress.direct, 1);
    assert.equal(progress.percentComplete, 99.9);
    assert.equal(progress.percentRemaining, 0.1);
    assert.equal(progress.percentComplete + progress.percentRemaining, 100);
  }
  queue.finish('task-3000', 'unavailable');
  assert.equal(queue.snapshot().processed, 3001);
  assert.equal(queue.snapshot().percentComplete, 100);
  assert.equal(queue.snapshot().percentRemaining, 0);
});

test('checkpoints are monotonic, bounded to a task and do not fabricate loaded areas for a cached result', () => {
  let saves = 0; const queue = new TripQueue(undefined, () => saves++);
  queue.reconcile([connection('a')]);
  assert.equal(queue.checkpoint('a', 1), false);
  assert.equal(queue.start('a'), true);
  assert.equal(queue.start('a'), false);
  assert.equal(queue.checkpoint('a', 1), true);
  const count = saves;
  assert.equal(queue.checkpoint('a', 1), true);
  assert.equal(saves, count);
  assert.equal(queue.checkpoint('a', 0), false);
  assert.equal(queue.checkpoint('a', 99), false);
  assert.equal(queue.checkpoint('a', 1.5), false);
  queue.finish('a', 'ready', undefined, route);
  assert.equal(queue.snapshot().areasProcessed, 1);
  assert.equal(queue.snapshot().percentComplete, 100);
  assert.equal(queue.checkpoint('a', 2), false);
});

test('reload preserves completed outcomes and paths while replaying only unfinished road geometry', () => {
  const queue = new TripQueue(); queue.reconcile(['ready', 'active', 'paused', 'missing'].map(connection));
  queue.finish('ready', 'ready', undefined, route);
  queue.finish('missing', 'no-path');
  queue.start('active'); queue.checkpoint('active', 1);
  queue.start('paused'); queue.checkpoint('paused', 1); queue.pause('paused', 'Paused by user.');
  const restored = new TripQueue(JSON.parse(JSON.stringify(queue.serialize())));
  assert.equal(restored.get('ready')?.state, 'ready');
  assert.deepEqual(restored.get('ready')?.route, route);
  assert.equal(restored.get('missing')?.state, 'no-path');
  assert.equal(restored.get('active')?.state, 'queued');
  assert.equal(restored.get('active')?.nextArea, 0);
  assert.equal(restored.get('active')?.restarted, true);
  assert.equal(restored.get('paused')?.state, 'paused');
  assert.equal(restored.get('paused')?.nextArea, 0);
  assert.equal(restored.get('paused')?.reason, 'Paused by user.');
  assert.equal(restored.snapshot().processed, 2);
  restored.resume('paused');
  assert.equal(restored.get('paused')?.state, 'queued');
});

test('durable paths exceed the old cache route count, total vertex count and per-path vertex limits', () => {
  const queue = new TripQueue();
  queue.reconcile(Array.from({ length: 550 }, (_, index) => connection(`saved-${index}`)));
  const geometry: RoadRoute = { distance: 2000, coordinates: Array.from({ length: 201 }, (_, index) => [114 + index / 100000, 22]) };
  for (let index = 0; index < 550; index++) assert.equal(queue.finish(`saved-${index}`, 'ready', undefined, geometry), true);
  queue.reconcile([connection('long-shape')]);
  const long: RoadRoute = { distance: 40000, coordinates: Array.from({ length: 12001 }, (_, index) => [114 + index / 100000, 22]) };
  queue.finish('long-shape', 'ready', undefined, long);
  const saved = queue.serialize();
  assert.equal(saved.tasks.filter(task => task.route).length, 551);
  assert.ok(saved.tasks.reduce((sum, task) => sum + (task.route?.coordinates.length ?? 0), 0) > 100000);
  const restored = new TripQueue(saved);
  assert.equal(restored.snapshot().ready, 551);
  assert.equal(restored.get('long-shape')?.route?.coordinates.length, 12001);
});

test('all exposed task, area and route data are defensive copies', () => {
  const original = connection('a'), copyRoute = structuredClone(route), queue = new TripQueue();
  queue.reconcile([original]); queue.finish('a', 'ready', undefined, copyRoute);
  original.from[0] = 0; original.areas[0].center[0] = 0; copyRoute.coordinates[0][0] = 0;
  const read = queue.get('a')!; read.from[0] = 0; read.areas[0].center[0] = 0; read.route!.coordinates[0][0] = 0;
  const serialized = queue.serialize(); serialized.tasks[0].route!.coordinates[0][0] = 0;
  assert.equal(queue.get('a')?.from[0], 114);
  assert.equal(queue.get('a')?.areas[0].center[0], 114);
  assert.equal(queue.get('a')?.route?.coordinates[0][0], 114);
});

test('malformed saved data cannot create invalid jobs or false ready paths', () => {
  const baseline = { ...connection('good'), state: 'queued', nextArea: 0, updatedAt: 1 };
  const data = { version: 1, tasks: [null, {}, { ...baseline, key: 'bad-point', from: [0, NaN] }, { ...baseline, key: 'bad-zoom', areas: [{ center: [0, 0], zoom: Infinity, stage: 'endpoint' }] }, { ...baseline, key: 'bad-zoom-17', areas: [{ center: [0, 0], zoom: 17, stage: 'endpoint' }] }, { ...baseline, key: 'bad-state', state: 'unknown' }, { ...baseline, key: 'bad-cursor', nextArea: 99 }, { ...baseline, key: 'missing-path', state: 'ready' }, { ...baseline, key: 'bad-path', state: 'ready', route: { distance: 0, coordinates: [[NaN, 0], [0, 0]] } }, baseline] };
  const queue = new TripQueue(data);
  assert.equal(queue.snapshot().total, 3);
  assert.equal(queue.snapshot().ready, 0);
  assert.equal(queue.get('missing-path')?.state, 'queued');
  assert.equal(queue.get('bad-path')?.route, undefined);
  assert.equal(new TripQueue({ version: 99, tasks: [baseline] }).snapshot().total, 0);
  assert.equal(queue.finish('good', 'ready', undefined, { distance: -1, coordinates: [[0, 0], [1, 1]] }), false);
});

test('dense area subdivision is durable and reconciliation never replaces it with the original coarse plan', () => {
  const queue = new TripQueue(); queue.reconcile([connection('a')]); queue.start('a');
  const children = subdivideTripArea(areas[0]);
  assert.equal(children.length, 4);
  assert.equal(queue.replaceArea('a', 1, children), false);
  assert.equal(queue.replaceArea('a', 0, children), true);
  queue.reconcile([connection('a')]);
  assert.equal(queue.get('a')?.areas.length, 5);
  const restored = new TripQueue(queue.serialize());
  assert.equal(restored.get('a')?.areas.length, 5);
  assert.ok(restored.get('a')!.areas.slice(0, 4).every(area => area.zoom === 15));
  assert.deepEqual(subdivideTripArea({ ...areas[0], zoom: 16 }), []);
});

test('retry and resume retain other completed tasks and reset only requested connections', () => {
  const queue = new TripQueue(); queue.reconcile(['a', 'b', 'c'].map(connection));
  queue.finish('a', 'ready', undefined, route); queue.finish('b', 'unavailable'); queue.pause('c', 'Memory budget.');
  queue.resume();
  assert.equal(queue.get('c')?.state, 'queued');
  assert.equal(queue.get('a')?.state, 'ready');
  assert.equal(queue.get('b')?.state, 'unavailable');
  queue.retry('a');
  assert.equal(queue.get('a')?.state, 'queued');
  assert.equal(queue.get('a')?.route, undefined);
  assert.equal(queue.finish('missing', 'ready'), false);
  assert.equal(queue.finish('c', 'ready'), false);
});

test('a city connection receives full street-detail corridor coverage with an early overview', () => {
  const plan = planTripConnection([114.1, 22.3], [114.24, 22.35]);
  assert.equal(plan.areas[0].stage, 'overview');
  assert.equal(plan.detailedCoverage, true);
  assert.ok(plan.areas.some(area => area.stage === 'endpoint' && area.zoom === 14));
  assert.ok(plan.areas.some(area => area.stage === 'corridor' && area.zoom === 14));
  assert.ok(plan.areas.length > 5);
  assert.ok(plan.distanceMeters > 10000);
});

test('a 1300 km connection is attempted across the region instead of being reduced to endpoints or omitted', () => {
  const plan = planTripConnection([114.17, 22.3], [116.4, 34.0]);
  assert.ok(plan.distanceMeters > 1200000);
  assert.equal(plan.detailedCoverage, false);
  assert.ok(plan.overviewZoom < 11);
  assert.ok(plan.areas.some(area => area.stage === 'corridor' && area.zoom < 14));
  assert.equal(plan.areas.filter(area => area.stage === 'endpoint').length, 2);
  assert.ok(plan.areas.length > 3);
  assert.ok(plan.areas.every(area => area.center.every(Number.isFinite)));
});

test('planning crosses the date line by its short direction and rejects invalid coordinates', () => {
  const plan = planTripConnection([179.99, 0], [-179.99, 0]);
  assert.ok(plan.distanceMeters < 3000);
  assert.ok(plan.areas.every(area => Math.abs(area.center[0]) > 179));
  assert.equal(plan.detailedCoverage, true);
  assert.deepEqual(planTripConnection([0, 91], [0, 0]).areas, []);
  assert.deepEqual(planTripConnection([NaN, 0], [0, 0]).areas, []);
  assert.ok(planTripConnection([0, 84], [0.1, 84.1]).areas.every(area => Math.abs(area.center[1]) <= 85.051129));
});

test('road distance limit is strict, geodesic and optional, including date-line crossings', () => {
  const from: [number, number] = [0, 0], to: [number, number] = [0.3, 0];
  const distanceKm = roadDistance(from, to) / 1000;
  assert.equal(exceedsRoadDistance(from, to, distanceKm), false);
  assert.equal(exceedsRoadDistance(from, to, distanceKm - 0.000001), true);
  assert.equal(exceedsRoadDistance(from, to, 30), true);
  for (const disabled of [undefined, null, 0, NaN, Infinity, -1]) assert.equal(exceedsRoadDistance(from, to, disabled), false);
  assert.equal(exceedsRoadDistance([179.99, 0], [-179.99, 0], 30), false);
});

test('distance-excluded connections stay direct and are omitted from all road calculation progress', () => {
  const queue = new TripQueue(); queue.reconcile([connection('direct')]);
  queue.start('direct'); queue.checkpoint('direct', 1);
  assert.equal(queue.setDirect('direct', 'Straight line: over 30 km.'), true);
  const progress = queue.snapshot();
  assert.equal(progress.total, 1);
  assert.equal(progress.direct, 1);
  assert.equal(progress.eligible, 0);
  assert.equal(progress.processed, 0);
  assert.equal(progress.percentComplete, 100);
  assert.equal(progress.percentRemaining, 0);
  assert.equal(progress.ready, 0);
  assert.equal(progress.noPath, 0);
  assert.equal(progress.unavailable, 0);
  assert.equal(progress.areasProcessed, 0);
  assert.equal(progress.areasTotal, 0);
  assert.equal(queue.start('direct'), false);
  assert.equal(queue.retry('direct'), false);
  assert.equal(queue.pause('direct'), false);
  queue.resume();
  assert.equal(queue.get('direct')?.state, 'direct');
  assert.equal(queue.finish('direct', 'ready', undefined, route), false);
  assert.equal(queue.get('direct')?.route, undefined);
});

test('mixed progress counts only eligible outcomes, pending work and their road areas', () => {
  const queue = new TripQueue();
  queue.reconcile(['ready', 'missing', 'offline', 'pending', 'direct', 'cached-direct'].map(connection));
  queue.start('ready'); queue.checkpoint('ready', 1); queue.finish('ready', 'ready', undefined, route);
  queue.finish('missing', 'no-path');
  queue.finish('offline', 'unavailable');
  queue.start('direct'); queue.checkpoint('direct', 1); queue.setDirect('direct');
  queue.start('cached-direct'); queue.checkpoint('cached-direct', 2);
  queue.finish('cached-direct', 'ready', undefined, route); queue.setDirect('cached-direct');
  assert.deepEqual(queue.snapshot(), {
    total: 6, eligible: 4, direct: 2, processed: 3, ready: 1, noPath: 1, unavailable: 1,
    paused: 0, queued: 1, preparing: 0, percentComplete: 75, percentRemaining: 25,
    areasProcessed: 1, areasTotal: 8,
  });
  const selected = queue.snapshot(['direct', 'direct', 'cached-direct', 'missing-key']);
  assert.equal(selected.total, 2);
  assert.equal(selected.eligible, 0);
  assert.equal(selected.direct, 2);
  assert.equal(selected.processed, 0);
  assert.equal(selected.areasProcessed, 0);
  assert.equal(selected.areasTotal, 0);
  assert.equal(selected.percentComplete, 100);
  assert.equal(selected.percentRemaining, 0);
  const empty = queue.snapshot([]);
  assert.equal(empty.total, 0);
  assert.equal(empty.eligible, 0);
  assert.equal(empty.direct, 0);
  assert.equal(empty.processed, 0);
  assert.equal(empty.percentComplete, 100);
  assert.equal(empty.percentRemaining, 0);
});

test('raising and lowering the distance limit updates eligible progress while retaining computed geometry', () => {
  const queue = new TripQueue();
  queue.reconcile(['ready', 'pending', 'cached-direct', 'new-direct'].map(connection));
  queue.finish('ready', 'ready', undefined, route);
  queue.finish('cached-direct', 'ready', undefined, route);
  queue.setDirect('cached-direct'); queue.setDirect('new-direct');
  assert.equal(queue.snapshot().eligible, 2);
  assert.equal(queue.snapshot().processed, 1);
  assert.equal(queue.snapshot().percentComplete, 50);
  const restored = new TripQueue(JSON.parse(JSON.stringify(queue.serialize())));
  assert.deepEqual(restored.snapshot(), queue.snapshot());
  restored.restoreDirect('cached-direct');
  assert.equal(restored.snapshot().eligible, 3);
  assert.equal(restored.snapshot().processed, 2);
  assert.equal(restored.snapshot().percentComplete, 66.7);
  assert.equal(restored.snapshot().percentRemaining, 33.3);
  assert.deepEqual(restored.get('cached-direct')?.route, route);
  restored.restoreDirect('new-direct', areas);
  assert.equal(restored.snapshot().eligible, 4);
  assert.equal(restored.snapshot().direct, 0);
  assert.equal(restored.snapshot().processed, 2);
  assert.equal(restored.snapshot().percentComplete, 50);
  restored.setDirect('new-direct'); restored.setDirect('pending');
  assert.equal(restored.snapshot().eligible, 2);
  assert.equal(restored.snapshot().processed, 2);
  assert.equal(restored.snapshot().percentComplete, 100);
  assert.equal(restored.snapshot().percentRemaining, 0);
});

test('lowering then raising the limit preserves and restores an already computed durable road path', () => {
  let saves = 0; const queue = new TripQueue(undefined, () => saves++);
  queue.reconcile([connection('saved')]); queue.finish('saved', 'ready', 'Computed.', route);
  queue.setDirect('saved', 'Over the new distance limit.');
  const unchangedSaves = saves;
  queue.setDirect('saved', 'Over the new distance limit.');
  assert.equal(saves, unchangedSaves);
  const stored = queue.serialize();
  assert.deepEqual(stored.tasks[0].route, route);
  stored.tasks[0].route!.coordinates[0][0] = 0;
  assert.equal(queue.get('saved')?.route?.coordinates[0][0], 114);
  const reopened = new TripQueue(queue.serialize());
  assert.equal(reopened.get('saved')?.state, 'direct');
  assert.equal(reopened.snapshot().direct, 1);
  assert.equal(reopened.snapshot().eligible, 0);
  assert.equal(reopened.snapshot().processed, 0);
  assert.equal(reopened.restoreDirect('saved'), true);
  assert.equal(reopened.get('saved')?.state, 'ready');
  assert.deepEqual(reopened.get('saved')?.route, route);
  assert.equal(reopened.next(), null);
  assert.equal(reopened.snapshot().direct, 0);
  assert.equal(reopened.snapshot().ready, 1);
  assert.equal(reopened.snapshot().eligible, 1);
  assert.equal(reopened.snapshot().processed, 1);
});

test('raising the limit rebuilds the area plan only for an uncalculated formerly direct connection', () => {
  const input = connection('new'); input.to = [115, 22]; input.areas = [];
  const queue = new TripQueue(); queue.reconcile([input]); queue.setDirect('new');
  const reopened = new TripQueue(queue.serialize());
  assert.equal(reopened.get('new')?.areas.length, 0);
  assert.equal(reopened.restoreDirect('new'), true);
  assert.equal(reopened.get('new')?.state, 'queued');
  assert.ok(reopened.get('new')!.areas.length > 0);
  assert.equal(reopened.get('new')?.nextArea, 0);
  assert.equal(reopened.snapshot().processed, 0);
  assert.equal(reopened.restoreDirect('missing'), false);
});

test('distance policy rejects invalid replacement plans without modifying the direct result', () => {
  const queue = new TripQueue(); queue.reconcile([connection('a')]); queue.setDirect('a');
  const before = queue.serialize();
  assert.equal(queue.restoreDirect('a', [{ center: [0, 91], zoom: 14, stage: 'endpoint' }]), false);
  assert.deepEqual(queue.serialize(), before);
  assert.equal(queue.restoreDirect('a', [{ center: [114, 22], zoom: 14, stage: 'endpoint' }]), true);
  assert.equal(queue.get('a')?.areas.length, 1);
});

test('distance changes preserve completed failures and a user pause across repeated edits and reload', () => {
  const queue = new TripQueue(); queue.reconcile(['missing', 'offline', 'paused'].map(connection));
  queue.start('missing'); queue.checkpoint('missing', 1);
  queue.finish('missing', 'no-path', 'No connected path in checked roads.');
  queue.finish('offline', 'unavailable', 'Some road data was unavailable.');
  queue.start('paused'); queue.checkpoint('paused', 1);
  queue.pause('paused', 'User paused.');
  const originalAreas = queue.get('paused')!.areas;
  for (const key of ['missing', 'offline', 'paused']) {
    queue.setDirect(key, 'Over 3 km.');
    queue.setDirect(key, 'Over 30 km.');
  }
  assert.equal(queue.get('missing')?.distancePreviousState, 'no-path');
  assert.equal(queue.get('missing')?.distancePreviousReason, 'No connected path in checked roads.');
  assert.equal(queue.get('paused')?.distancePreviousState, 'paused');
  const restored = new TripQueue(queue.serialize());
  const newPlan: TripArea[] = [{ center: [115, 22], zoom: 12, stage: 'overview' }];
  for (const key of ['missing', 'offline', 'paused']) assert.equal(restored.restoreDirect(key, newPlan), true);
  assert.equal(restored.get('missing')?.state, 'no-path');
  assert.equal(restored.get('missing')?.reason, 'No connected path in checked roads.');
  assert.equal(restored.get('missing')?.nextArea, 1);
  assert.equal(restored.get('offline')?.state, 'unavailable');
  assert.equal(restored.get('offline')?.reason, 'Some road data was unavailable.');
  assert.equal(restored.get('paused')?.state, 'paused');
  assert.equal(restored.get('paused')?.reason, 'User paused.');
  assert.deepEqual(restored.get('paused')?.areas, originalAreas);
  assert.equal(restored.next(), null);
  assert.equal(restored.snapshot().processed, 2);
  assert.equal(restored.snapshot().paused, 1);
  assert.equal(restored.snapshot().direct, 0);
  assert.equal(restored.get('missing')?.distancePreviousState, undefined);
  assert.equal(restored.get('paused')?.distancePreviousReason, undefined);
  restored.retry('missing');
  assert.equal(restored.get('missing')?.state, 'queued');
  assert.equal(restored.get('missing')?.distancePreviousState, undefined);
});

test('distance-excluded queued and interrupted connections resume calculation, while old records remain compatible', () => {
  const queue = new TripQueue(); queue.reconcile(['new', 'active', 'legacy'].map(connection));
  queue.start('active'); queue.checkpoint('active', 1);
  for (const key of ['new', 'active', 'legacy']) queue.setDirect(key);
  const data = queue.serialize();
  const legacy = data.tasks.find(task => task.key === 'legacy')!;
  delete legacy.distancePreviousState; delete legacy.distancePreviousReason; legacy.areas = [];
  const restored = new TripQueue(data);
  for (const key of ['new', 'active', 'legacy']) {
    assert.equal(restored.restoreDirect(key), true);
    assert.equal(restored.get(key)?.state, 'queued');
    assert.equal(restored.get(key)?.nextArea, 0);
    assert.ok(restored.get(key)!.areas.length > 0);
  }
});

test('invalid distance previous metadata cannot create a state or persist unsafe reasons', () => {
  const queue = new TripQueue(); queue.reconcile([connection('a')]); queue.setDirect('a');
  const data = queue.serialize() as unknown as { version: number; tasks: Array<Record<string, unknown>> };
  data.tasks[0].distancePreviousState = 'direct';
  data.tasks[0].distancePreviousReason = 'x'.repeat(501);
  const invalidState = new TripQueue(data);
  assert.equal(invalidState.get('a')?.distancePreviousState, undefined);
  assert.equal(invalidState.get('a')?.distancePreviousReason, undefined);
  assert.equal(invalidState.restoreDirect('a'), true);
  assert.equal(invalidState.get('a')?.state, 'queued');
  data.tasks[0].distancePreviousState = 'paused';
  const invalidReason = new TripQueue(data);
  assert.equal(invalidReason.get('a')?.distancePreviousState, 'paused');
  assert.equal(invalidReason.get('a')?.distancePreviousReason, undefined);
  invalidReason.restoreDirect('a');
  assert.equal(invalidReason.get('a')?.state, 'paused');
});

test('split checkpoints persist completed path prefixes while only temporary area progress replays after reload', () => {
  let saves = 0;
  const queue = new TripQueue(undefined, () => saves++);
  queue.reconcile([connection('active'), connection('paused')]);
  assert.equal(queue.setSplit('active', splitProgress()), false);
  queue.start('active'); queue.checkpoint('active', 1);
  assert.equal(queue.setSplit('active', splitProgress()), true);
  const saved = saves;
  assert.equal(queue.setSplit('active', splitProgress()), true);
  assert.equal(saves, saved);
  queue.start('paused'); queue.setSplit('paused', splitProgress()); queue.pause('paused', 'User paused.');
  const reopened = new TripQueue(JSON.parse(JSON.stringify(queue.serialize())));
  assert.equal(reopened.get('active')?.state, 'queued');
  assert.equal(reopened.get('active')?.nextArea, 0);
  assert.deepEqual(reopened.get('active')?.split, splitProgress());
  assert.equal(reopened.get('paused')?.state, 'paused');
  reopened.resume('paused');
  assert.equal(reopened.get('paused')?.state, 'queued');
  assert.deepEqual(reopened.get('paused')?.split, splitProgress());
});

test('split checkpoint input, returned task, serialization and loaded checkpoints are defensive deep copies', () => {
  const queue = new TripQueue(); queue.reconcile([connection('a')]); queue.start('a');
  const initial = splitProgress(); queue.setSplit('a', initial);
  initial.frontier[0].anchor.point[0] = 0;
  initial.frontier[0].route.coordinates[0][0] = 0;
  const read = queue.get('a')!; read.split!.frontier[0].anchor.point[0] = 0;
  read.split!.frontier[0].route.coordinates[1][0] = 0;
  const stored = queue.serialize();
  const reopened = new TripQueue(stored);
  stored.tasks[0].split!.frontier[0].anchor.point[0] = 0;
  stored.tasks[0].split!.frontier[0].route.coordinates[0][0] = 0;
  assert.deepEqual(queue.get('a')?.split, splitProgress());
  assert.deepEqual(reopened.get('a')?.split, splitProgress());
  const next = reopened.next()!; next.split!.frontier[0].anchor.point[0] = 0;
  assert.deepEqual(reopened.get('a')?.split, splitProgress());
});

test('guided search checkpoints reload without promoting coarse guidance to a finished road path', () => {
  const queue = new TripQueue(); queue.reconcile([connection('pending'), connection('guided'), connection('ordinary')]);
  for (const key of ['pending', 'guided', 'ordinary']) queue.start(key);
  const pending: TripSplitProgress = { version: 1, pass: 0, nextPart: 0, totalParts: 0, frontier: [], guided: true };
  const guided: TripSplitProgress = { ...splitProgress(), guided: true, guide: structuredClone(route) };
  assert.equal(queue.setSplit('pending', pending), true);
  assert.equal(queue.setSplit('guided', guided), true);
  assert.equal(queue.setSplit('ordinary', { ...splitProgress(), guided: false }), true);
  const restored = new TripQueue(JSON.parse(JSON.stringify(queue.serialize())));
  assert.deepEqual(restored.get('pending')?.split, pending);
  assert.deepEqual(restored.get('guided')?.split, guided);
  assert.equal(restored.get('ordinary')?.split?.guided, false);
  for (const key of ['pending', 'guided', 'ordinary']) {
    assert.equal(restored.get(key)?.state, 'queued');
    assert.equal(restored.get(key)?.route, undefined);
  }
  assert.equal(restored.snapshot().ready, 0);
  assert.equal(restored.snapshot().processed, 0);
  assert.equal(queue.finish('guided', 'ready'), false);
  assert.equal(queue.get('guided')?.route, undefined);
  assert.equal(queue.finish('guided', 'unavailable', 'Guided refinement had insufficient map detail.'), true);
  assert.equal(queue.get('guided')?.split, undefined);
  assert.equal(queue.get('guided')?.route, undefined);
});

test('saved coarse guide geometry is copied defensively through checkpoint, read, queue and reload APIs', () => {
  const queue = new TripQueue(); queue.reconcile([connection('a')]); queue.start('a');
  const progress: TripSplitProgress = { ...splitProgress(), guided: true, guide: structuredClone(route) };
  assert.equal(queue.setSplit('a', progress), true);
  progress.guide!.coordinates[0][0] = 0;
  progress.guide!.distance = 0;
  const read = queue.get('a')!; read.split!.guide!.coordinates[1][0] = 0;
  const serialized = queue.serialize();
  const restored = new TripQueue(serialized);
  serialized.tasks[0].split!.guide!.coordinates[2][0] = 0;
  serialized.tasks[0].split!.guide!.distance = 0;
  const expected = { ...splitProgress(), guided: true, guide: route };
  assert.deepEqual(queue.get('a')?.split, expected);
  assert.deepEqual(restored.get('a')?.split, expected);
  const next = restored.next()!; next.split!.guide!.coordinates[0][0] = 0;
  assert.deepEqual(restored.get('a')?.split, expected);
});

test('guided checkpoints reject malformed flags and invalid or unguided coarse routes on input and reload', () => {
  const queue = new TripQueue(); queue.reconcile([connection('a')]); queue.start('a');
  const ordinary = splitProgress();
  const candidates: unknown[] = [
    ...[null, 0, 1, 'true', {}, []].map(guided => ({ ...ordinary, guided })),
    { ...ordinary, guide: route }, { ...ordinary, guided: false, guide: route },
    { ...ordinary, guided: true, guide: null }, { ...ordinary, guided: true, guide: {} },
    { ...ordinary, guided: true, guide: { ...route, distance: -1 } },
    { ...ordinary, guided: true, guide: { ...route, distance: Infinity } },
    { ...ordinary, guided: true, guide: { ...route, coordinates: [[114, 22]] } },
    { ...ordinary, guided: true, guide: { ...route, coordinates: [[114, 22], [NaN, 22]] } },
    { ...ordinary, guided: true, guide: { ...route, coordinates: Array(2) } },
  ];
  for (const invalid of candidates) {
    assert.equal(queue.setSplit('a', invalid as TripSplitProgress), false);
    const saved = queue.serialize();
    (saved.tasks[0] as unknown as Record<string, unknown>).split = invalid;
    const restored = new TripQueue(saved);
    assert.equal(restored.get('a')?.split, undefined);
    assert.equal(restored.get('a')?.route, undefined);
    assert.equal(restored.get('a')?.state, 'queued');
  }
});

test('split checkpoints validate versions, passes, cursors, frontier bounds, finite anchors and connected seams', () => {
  const queue = new TripQueue(); queue.reconcile([connection('a')]); queue.start('a');
  const valid = splitProgress();
  const candidates: unknown[] = [null, {}, { ...valid, version: 2 }, { ...valid, pass: -1 }, { ...valid, pass: 3 },
    { ...valid, pass: 0.5 }, { ...valid, nextPart: -1 }, { ...valid, nextPart: 5 }, { ...valid, nextPart: NaN },
    { ...valid, nextPart: 1.5 }, { ...valid, totalParts: Infinity }, { ...valid, totalParts: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, frontier: [] }, { ...valid, frontier: Array(1) }, { ...valid, frontier: Array(13).fill(valid.frontier[0]) },
    { ...valid, frontier: [null] }, { ...valid, frontier: [{ ...valid.frontier[0], anchor: null }] },
    { ...valid, frontier: [{ ...valid.frontier[0], anchor: { point: [114.01, NaN], grade: 'ground|0|0' } }] },
    { ...valid, frontier: [{ ...valid.frontier[0], anchor: { point: [114.01, 91], grade: 'ground|0|0' } }] },
    { ...valid, frontier: [{ ...valid.frontier[0], anchor: { point: [114.01, 22], grade: '' } }] },
    { ...valid, frontier: [{ ...valid.frontier[0], anchor: { point: [114.01, 22], grade: 'x'.repeat(257) } }] },
    { ...valid, frontier: [{ ...valid.frontier[0], anchor: { point: [114.01001, 22], grade: 'ground|0|0' } }] },
    { ...valid, frontier: [{ ...valid.frontier[0], route: { ...route, distance: -1 } }] },
    { ...valid, frontier: [{ ...valid.frontier[0], route: { ...route, coordinates: [[114.01, 22]] } }] },
    { ...valid, frontier: [{ ...valid.frontier[0], route: { ...route, coordinates: Array(2) } }] },
  ];
  for (const invalid of candidates) {
    assert.equal(queue.setSplit('a', invalid as TripSplitProgress), false);
    const stored = queue.serialize();
    (stored.tasks[0] as unknown as Record<string, unknown>).split = invalid;
    const reopened = new TripQueue(stored);
    assert.equal(reopened.get('a')?.state, 'queued');
    assert.equal(reopened.get('a')?.split, undefined);
  }
  assert.equal(queue.setSplit('a', { ...valid, pass: 0, nextPart: 0, totalParts: 0, frontier: [] }), true);
  const close = splitProgress(); close.frontier[0].anchor.point[1] += 0.0000001;
  assert.equal(queue.setSplit('a', close), true);
  assert.equal(queue.setSplit('a', { ...valid, pass: 2, nextPart: 4, frontier: Array(12).fill(valid.frontier[0]) }), true);
  for (const bearing of [-1, 181, NaN, Infinity, null, '0']) {
    const invalid = structuredClone(valid) as unknown as { frontier: Array<{ anchor: Record<string, unknown> }> };
    invalid.frontier[0].anchor.bearing = bearing;
    assert.equal(queue.setSplit('a', invalid as unknown as TripSplitProgress), false);
    const stored = queue.serialize();
    (stored.tasks[0] as unknown as Record<string, unknown>).split = invalid;
    assert.equal(new TripQueue(stored).get('a')?.split, undefined);
  }
  for (const bearing of [0, 45, 180]) {
    const withBearing = splitProgress(); withBearing.frontier[0].anchor.bearing = bearing;
    assert.equal(queue.setSplit('a', withBearing), true);
    withBearing.frontier[0].anchor.bearing = 90;
    assert.equal(queue.get('a')?.split?.frontier[0].anchor.bearing, bearing);
    assert.equal(new TripQueue(queue.serialize()).get('a')?.split?.frontier[0].anchor.bearing, bearing);
  }
});

test('automatic interrupted requeue retains split paths and never resurrects an explicit pause or terminal task', () => {
  const queue = new TripQueue(); queue.reconcile(['a', 'paused', 'ready', 'direct'].map(connection));
  queue.start('a'); queue.setSplit('a', splitProgress()); queue.checkpoint('a', 1);
  assert.equal(queue.requeue('a'), true);
  assert.equal(queue.get('a')?.state, 'queued');
  assert.equal(queue.get('a')?.nextArea, 0);
  assert.deepEqual(queue.get('a')?.split, splitProgress());
  queue.start('paused'); queue.setSplit('paused', splitProgress()); queue.pause('paused', 'User paused.');
  queue.finish('ready', 'ready', undefined, route); queue.setDirect('direct');
  for (const key of ['paused', 'ready', 'direct', 'missing']) assert.equal(queue.requeue(key), false);
  assert.equal(queue.get('paused')?.state, 'paused');
  assert.deepEqual(queue.get('paused')?.split, splitProgress());
});

test('explicit retries discard split checkpoints, while all terminal outcomes release their intermediate paths', () => {
  const queue = new TripQueue(); queue.reconcile(['queued', 'ready', 'no-path', 'unavailable'].map(connection));
  for (const key of ['queued', 'ready', 'no-path', 'unavailable']) { queue.start(key); queue.setSplit(key, splitProgress()); }
  queue.requeue('queued');
  assert.equal(queue.retry('queued'), true);
  assert.equal(queue.get('queued')?.split, undefined);
  for (const state of ['ready', 'no-path', 'unavailable'] as const) {
    assert.equal(queue.finish(state, state, undefined, state === 'ready' ? route : undefined), true);
    assert.equal(queue.get(state)?.split, undefined);
    assert.equal(queue.setSplit(state, splitProgress()), false);
  }
});

test('distance exclusion and restoration retain split checkpoints and preserve an explicit user pause', () => {
  const queue = new TripQueue(); queue.reconcile(['active', 'paused'].map(connection));
  for (const key of ['active', 'paused']) { queue.start(key); queue.setSplit(key, splitProgress()); }
  queue.pause('paused', 'User paused.');
  queue.setDirect('active'); queue.setDirect('paused');
  const reopened = new TripQueue(queue.serialize());
  assert.equal(reopened.setSplit('active', splitProgress()), false);
  reopened.restoreDirect('active'); reopened.restoreDirect('paused');
  assert.equal(reopened.get('active')?.state, 'queued');
  assert.deepEqual(reopened.get('active')?.split, splitProgress());
  assert.equal(reopened.get('paused')?.state, 'paused');
  assert.equal(reopened.get('paused')?.reason, 'User paused.');
  assert.deepEqual(reopened.get('paused')?.split, splitProgress());
  assert.equal(reopened.upgradeBudgetPauses(), 0);
});

test('legacy budget migration upgrades only exact known resource pauses and initializes the split strategy once', () => {
  let saves = 0;
  const queue = new TripQueue(undefined, () => saves++, () => 123);
  const reasons = [
    'Working data limit in Eco. Select a larger workload mode and Resume.',
    'Working data limit in Balanced. Select a larger workload mode and Resume.',
    'Working data limit in Maximum. This connection needs a different search strategy or regional routing data; progress is saved.',
    'User paused. Resume continues pending connections.',
    'Paused by user.',
    'The local search could not finish within the working budget. Resume or select a larger workload mode.',
    'Chunk loading time limit reached. Resume retries this connection; previous results are saved.',
    'Working data limit in Eco. Select a larger workload mode and Resume. Extra detail.',
  ];
  queue.reconcile(reasons.map((_reason, index) => connection(`pause-${index}`)));
  reasons.forEach((reason, index) => { queue.start(`pause-${index}`); queue.checkpoint(`pause-${index}`, 1); queue.pause(`pause-${index}`, reason); });
  const before = saves;
  assert.equal(queue.upgradeBudgetPauses(['pause-0', 'pause-0', 'missing']), 1);
  assert.equal(saves, before + 1);
  assert.equal(queue.upgradeBudgetPauses(), 2);
  for (let index = 0; index < 3; index++) {
    const task = queue.get(`pause-${index}`)!;
    assert.equal(task.state, 'queued'); assert.equal(task.nextArea, 0); assert.equal(task.updatedAt, 123);
    assert.equal(task.reason, undefined);
    assert.deepEqual(task.split, { version: 1, pass: 0, nextPart: 0, totalParts: 0, frontier: [] });
  }
  for (let index = 3; index < reasons.length; index++) assert.equal(queue.get(`pause-${index}`)?.state, 'paused');
  queue.pause('pause-0', reasons[0]);
  const reopened = new TripQueue(queue.serialize());
  assert.equal(reopened.upgradeBudgetPauses(), 0);
  assert.equal(reopened.get('pause-0')?.state, 'paused');
  assert.deepEqual(reopened.get('pause-0')?.split, { version: 1, pass: 0, nextPart: 0, totalParts: 0, frontier: [] });
});

test('legacy budget migration leaves distance exclusions untouched until restored and never restarts terminal outcomes', () => {
  const reason = 'Working data limit in Eco. Select a larger workload mode and Resume.';
  const queue = new TripQueue(); queue.reconcile(['direct', 'ready', 'unavailable', 'no-path'].map(connection));
  queue.pause('direct', reason); queue.setDirect('direct');
  queue.finish('ready', 'ready', reason, route); queue.finish('unavailable', 'unavailable', reason); queue.finish('no-path', 'no-path', reason);
  const reopened = new TripQueue(queue.serialize());
  assert.equal(reopened.upgradeBudgetPauses(), 0);
  assert.equal(reopened.get('direct')?.state, 'direct');
  reopened.restoreDirect('direct');
  assert.equal(reopened.get('direct')?.state, 'paused');
  assert.equal(reopened.upgradeBudgetPauses(), 1);
  assert.equal(reopened.get('direct')?.state, 'queued');
  assert.equal(reopened.snapshot().processed, 3);
});

test('guided migration selects only the exact legacy unavailable failure and initializes it once', () => {
  const legacyReason = 'Automatic section searches could not assemble a connected walking path from the available road data. Barriers, missing detail or local data limits may prevent routing; this is not proof that no path exists.';
  let saves = 0;
  const queue = new TripQueue(undefined, () => saves++, () => 123);
  queue.reconcile(['legacy-a', 'legacy-b', 'other', 'similar', 'paused', 'no-path', 'ready', 'queued', 'active', 'direct'].map(connection));
  queue.finish('legacy-a', 'unavailable', legacyReason);
  queue.finish('legacy-b', 'unavailable', legacyReason);
  queue.finish('other', 'unavailable', 'Road detail was unavailable.');
  queue.finish('similar', 'unavailable', `${legacyReason} Extra detail.`);
  queue.pause('paused', legacyReason);
  queue.finish('no-path', 'no-path', legacyReason);
  queue.finish('ready', 'ready', legacyReason, route);
  queue.start('active');
  queue.finish('direct', 'unavailable', legacyReason); queue.setDirect('direct');
  const preservedKeys = ['other', 'similar', 'paused', 'no-path', 'ready', 'queued', 'active', 'direct'];
  const preserved = preservedKeys.map(key => queue.get(key));
  const before = saves;
  assert.equal(queue.upgradeGuidedSearchFailures(['legacy-a', 'legacy-a', 'missing']), 1);
  assert.equal(saves, before + 1);
  assert.equal(queue.upgradeGuidedSearchFailures(), 1);
  assert.equal(saves, before + 2);
  for (const key of ['legacy-a', 'legacy-b']) {
    const task = queue.get(key)!;
    assert.equal(task.state, 'queued'); assert.equal(task.nextArea, 0);
    assert.equal(task.reason, undefined); assert.equal(task.restarted, true); assert.equal(task.updatedAt, 123);
    assert.deepEqual(task.split, { version: 1, pass: 0, nextPart: 0, totalParts: 0, frontier: [], guided: true });
    assert.equal(task.route, undefined);
  }
  assert.deepEqual(preservedKeys.map(key => queue.get(key)), preserved);
  assert.equal(queue.upgradeGuidedSearchFailures(), 0);
  assert.equal(saves, before + 2);
  const restored = new TripQueue(JSON.parse(JSON.stringify(queue.serialize())));
  assert.equal(restored.upgradeGuidedSearchFailures(), 0);
  assert.equal(restored.get('paused')?.state, 'paused');
  restored.start('legacy-a');
  restored.finish('legacy-a', 'unavailable', 'Guided section searches could not assemble a connected walking path.');
  assert.equal(restored.upgradeGuidedSearchFailures(), 0);
  assert.equal(restored.get('legacy-a')?.state, 'unavailable');
  assert.equal(restored.get('legacy-a')?.split, undefined);
  restored.restoreDirect('direct');
  assert.equal(restored.upgradeGuidedSearchFailures(['direct']), 1);
  assert.equal(restored.get('direct')?.state, 'queued');
  assert.equal(restored.get('direct')?.split?.guided, true);
});

test('changing pin access retries unresolved outcomes and active split prefixes while retaining saved paths and pauses', () => {
  const queue = new TripQueue();
  queue.reconcile(['ready', 'direct', 'user-paused', 'error-paused', 'no-path', 'unavailable', 'queued-split', 'preparing-split', 'queued', 'preparing'].map(connection));
  queue.finish('ready', 'ready', 'Saved.', route);
  queue.finish('direct', 'unavailable', 'Previous result.'); queue.setDirect('direct');
  queue.start('user-paused'); queue.setSplit('user-paused', splitProgress()); queue.pause('user-paused', 'User paused.');
  queue.pause('error-paused', 'Unexpected local failure.');
  queue.finish('no-path', 'no-path', 'No connected route.'); queue.finish('unavailable', 'unavailable', 'Map detail missing.');
  queue.start('queued-split'); queue.setSplit('queued-split', splitProgress()); queue.requeue('queued-split');
  queue.start('preparing-split'); queue.setSplit('preparing-split', splitProgress());
  queue.start('preparing'); queue.checkpoint('preparing', 1);
  const preserved = ['ready', 'direct', 'user-paused', 'error-paused', 'queued', 'preparing'].map(key => queue.get(key));
  assert.equal(queue.restartAccessSearches(), 4);
  for (const key of ['no-path', 'unavailable', 'queued-split', 'preparing-split']) {
    const task = queue.get(key)!;
    assert.equal(task.state, 'queued'); assert.equal(task.nextArea, 0);
    assert.equal(task.split, undefined); assert.equal(task.reason, undefined); assert.equal(task.route, undefined);
  }
  assert.deepEqual(['ready', 'direct', 'user-paused', 'error-paused', 'queued', 'preparing'].map(key => queue.get(key)), preserved);
  assert.equal(queue.restartAccessSearches(), 0);
  assert.deepEqual(queue.get('ready')?.route, route);
  assert.deepEqual(queue.get('user-paused')?.split, splitProgress());
});

test('access retries are durable, idempotent and avoid task deep copies during the scan', () => {
  let saves = 0;
  const queue = new TripQueue(undefined, () => saves++);
  queue.reconcile([connection('missing'), connection('prefix'), connection('other')]);
  queue.finish('missing', 'unavailable'); queue.start('prefix'); queue.setSplit('prefix', splitProgress());
  queue.get = () => { throw Error('Retry scanning must not deep-copy stored routes.'); };
  const before = saves;
  assert.equal(queue.restartAccessSearches(), 2);
  assert.equal(saves, before + 2);
  assert.equal(queue.restartAccessSearches(), 0);
  assert.equal(saves, before + 2);
  const restored = new TripQueue(queue.serialize());
  assert.equal(restored.get('missing')?.state, 'queued');
  assert.equal(restored.get('prefix')?.state, 'queued');
  assert.equal(restored.get('prefix')?.split, undefined);
  assert.equal(restored.restartAccessSearches(), 0);
});
