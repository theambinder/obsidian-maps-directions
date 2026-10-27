import assert from 'node:assert/strict';
import test from 'node:test';
import { TripQueue, tripConnectionKey, planTripConnection, subdivideTripArea, type TripArea, type TripConnection } from '../src/trip-queue';
import type { RoadRoute } from '../src/road-graph';

const areas: TripArea[] = [
  { center: [114, 22], zoom: 14, stage: 'endpoint' },
  { center: [114.01, 22], zoom: 14, stage: 'corridor' },
];
function connection(key: string): TripConnection { return { key, from: [114, 22], to: [114.01, 22], areas: areas.map(area => ({ ...area, center: [...area.center] })) }; }
const route: RoadRoute = { coordinates: [[114, 22], [114.005, 22.001], [114.01, 22]], distance: 1200 };

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
    preparing: 0, percentComplete: 75, percentRemaining: 25, areasProcessed: 0, areasTotal: 8,
  });
  assert.equal(new TripQueue().snapshot().percentRemaining, 0);
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
