import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import type { RoutingJob, RoutingResult } from '../src/routing-protocol';

test('the shipped worker routes ordered legs locally and returns explicit failures per leg', () => {
  const bundled = buildSync({ entryPoints: ['src/local-routing-worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020' }).outputFiles[0].text;
  let result: RoutingResult | undefined;
  const scope = { onmessage: null as ((event: { data: RoutingJob }) => void) | null, postMessage: (message: RoutingResult) => { result = message; } };
  runInNewContext(bundled, scope);
  scope.onmessage!({ data: {
    id: 42, graphKey: 'test',
    features: [{ geometry: { type: 'LineString', coordinates: [[139, 35], [139.001, 35], [139.001, 35.001]] }, properties: { class: 'minor' } }],
    legs: [{ from: [139, 35], to: [139.001, 35.001] }, { from: [138, 34], to: [138.001, 34.001] }],
  } });
  assert.equal(result!.id, 42);
  assert.equal(result!.routes.length, 2);
  assert.ok(result!.routes[0]!.coordinates.length >= 3);
  assert.equal(result!.routes[1], null);
  assert.ok(result!.stats.edges > 0);
  assert.equal(Object.hasOwn(result!, 'portals'), false);
});

test('the shipped worker returns real level-aware portals and reuses its graph for gate-only requests', () => {
  const bundled = buildSync({ entryPoints: ['src/local-routing-worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020' }).outputFiles[0].text;
  const messages: RoutingResult[] = [];
  const scope = { onmessage: null as ((event: { data: RoutingJob }) => void) | null, postMessage: (message: RoutingResult) => { messages.push(message); } };
  runInNewContext(bundled, scope);
  const gate: NonNullable<RoutingJob['gate']> = { from: [0, 0], to: [0.002, 0], center: [0.001, 0], halfWidthMeters: 100 };
  scope.onmessage!({ data: {
    id: 1, graphKey: 'portal-roads', gate, legs: [],
    features: [
      { geometry: { type: 'LineString', coordinates: [[0, 0], [0.002, 0]] }, properties: { class: 'minor' } },
      { geometry: { type: 'LineString', coordinates: [[0, 0.0004], [0.002, 0.0004]] }, properties: { class: 'minor', brunnel: 'bridge', layer: 1 } },
      { geometry: { type: 'LineString', coordinates: [[0, -0.0004], [0.002, -0.0004]] }, properties: { class: 'minor', foot: 'no' } },
    ],
  } });
  assert.equal(messages[0].error, undefined);
  assert.equal(messages[0].routes.length, 0);
  assert.equal(messages[0].portals?.length, 2);
  const portals = messages[0].portals!;
  assert.ok(portals.some(anchor => anchor.grade === 'ground|0|0' && Math.abs(anchor.point[0] - 0.001) < 1e-9 && Math.abs(anchor.point[1]) < 1e-9));
  assert.ok(portals.some(anchor => anchor.grade === 'bridge|1|0' && Math.abs(anchor.point[0] - 0.001) < 1e-9 && Math.abs(anchor.point[1] - 0.0004) < 1e-9));
  scope.onmessage!({ data: { id: 2, graphKey: 'portal-roads', gate, legs: [], features: [] } });
  assert.equal(messages[1].portals?.length, 2);
  assert.equal(messages[1].stats.edges, messages[0].stats.edges);
});

test('the shipped worker applies strict internal anchors without ordinary nearby-road or wrong-level fallback', () => {
  const bundled = buildSync({ entryPoints: ['src/local-routing-worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020' }).outputFiles[0].text;
  let result: RoutingResult | undefined;
  const scope = { onmessage: null as ((event: { data: RoutingJob }) => void) | null, postMessage: (message: RoutingResult) => { result = message; } };
  runInNewContext(bundled, scope);
  scope.onmessage!({ data: {
    id: 7, graphKey: 'strict-seams',
    features: [
      { geometry: { type: 'LineString', coordinates: [[0, 0], [0.002, 0]] }, properties: { class: 'minor' } },
      { geometry: { type: 'LineString', coordinates: [[0.001, -0.01], [0.001, 0.01]] }, properties: { class: 'minor', brunnel: 'bridge', layer: 1 } },
    ],
    legs: [
      { from: [0.001, 0], to: [0.002, 0], fromAnchor: { point: [0.001, 0], grade: 'ground|0|0' }, toAnchor: { point: [0.002, 0], grade: 'ground|0|0' } },
      { from: [0.001, 0], to: [0.002, 0], fromAnchor: { point: [0.001, 0], grade: 'bridge|1|0' }, toAnchor: { point: [0.002, 0], grade: 'ground|0|0' }, maxSnapMeters: 1000 },
      { from: [0.001, 0.000001], to: [0.002, 0], fromAnchor: { point: [0.001, 0.000001], grade: 'ground|0|0' }, maxSnapMeters: 1000 },
      { from: [0, 0], to: [0.002, 0], toAnchor: { point: [0.002, 0], grade: 'tunnel|-1|0' }, maxSnapMeters: 1000 },
      { from: [0.001, 0.000001], to: [0.002, 0] },
    ],
  } });
  assert.equal(result!.error, undefined);
  assert.equal(result!.routes.length, 5);
  assert.ok(result!.routes[0]);
  assert.equal(result!.routes[1], null);
  assert.equal(result!.routes[2], null);
  assert.equal(result!.routes[3], null);
  assert.ok(result!.routes[4]);
  assert.equal(Object.hasOwn(result!, 'portals'), false);
});

test('the shipped worker honors per-leg endpoint radii up to 1000 m while preserving the 100 m default', () => {
  const bundled = buildSync({ entryPoints: ['src/local-routing-worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020' }).outputFiles[0].text;
  let result: RoutingResult | undefined;
  const scope = { onmessage: null as ((event: { data: RoutingJob }) => void) | null, postMessage: (message: RoutingResult) => { result = message; } };
  runInNewContext(bundled, scope);
  scope.onmessage!({ data: {
    id: 9, graphKey: 'endpoint-radii',
    features: [{ geometry: { type: 'LineString', coordinates: [[0, 0], [0.01, 0]] }, properties: { class: 'minor' } }],
    legs: [
      { from: [0, 0.002], to: [0.01, 0.002] },
      { from: [0, 0.002], to: [0.01, 0.002], maxSnapMeters: 250 },
      { from: [0, 0.008], to: [0.01, 0.008], maxSnapMeters: 1000 },
      { from: [0, 0.011], to: [0.01, 0.011], maxSnapMeters: 1000 },
      { from: [0, 0.012], to: [0.01, 0.012], maxSnapMeters: 2000 },
      { from: [0, 0], to: [0.01, 0], maxSnapMeters: 0 },
      { from: [0, 0.000001], to: [0.01, 0.000001], maxSnapMeters: 0 },
    ],
  } });
  assert.equal(result!.error, undefined);
  assert.equal(result!.routes.length, 7);
  assert.equal(result!.routes[0], null);
  assert.ok(result!.routes[1]);
  assert.ok(result!.routes[2]);
  assert.equal(result!.routes[3], null);
  assert.equal(result!.routes[4], null);
  assert.ok(result!.routes[5]);
  assert.equal(result!.routes[6], null);
  for (const index of [1, 2, 5]) assert.ok(result!.routes[index]!.coordinates.every(point => point[1] === 0));
});

test('a worker-discovered bearing survives clipping but rejects a perpendicular same-level seam', () => {
  const bundled = buildSync({ entryPoints: ['src/local-routing-worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020' }).outputFiles[0].text;
  const messages: RoutingResult[] = [];
  const scope = { onmessage: null as ((event: { data: RoutingJob }) => void) | null, postMessage: (message: RoutingResult) => { messages.push(message); } };
  runInNewContext(bundled, scope);
  scope.onmessage!({ data: {
    id: 1, graphKey: 'complete-road', legs: [],
    gate: { from: [-0.002, 0], to: [0.002, 0], center: [0, 0], halfWidthMeters: 100 },
    features: [{ geometry: { type: 'LineString', coordinates: [[-0.002, 0], [0.002, 0]] }, properties: { class: 'minor' } }],
  } });
  const anchor = messages[0].portals![0];
  assert.equal(typeof anchor.bearing, 'number');
  assert.ok(anchor.bearing! >= 0 && anchor.bearing! <= 180);
  scope.onmessage!({ data: {
    id: 2, graphKey: 'clipped-same-road',
    legs: [{ from: anchor.point, to: [0.002, 0], fromAnchor: anchor }],
    features: [{ geometry: { type: 'LineString', coordinates: [anchor.point, [0.002, 0]] }, properties: { class: 'minor' } }],
  } });
  assert.equal(messages[1].error, undefined);
  assert.ok(messages[1].routes[0]);
  scope.onmessage!({ data: {
    id: 3, graphKey: 'perpendicular-road',
    legs: [{ from: anchor.point, to: [0, 0.002], fromAnchor: anchor }, { from: anchor.point, to: [0, 0.002] }],
    features: [{ geometry: { type: 'LineString', coordinates: [anchor.point, [0, 0.002]] }, properties: { class: 'minor' } }],
  } });
  assert.equal(messages[2].error, undefined);
  assert.equal(messages[2].routes[0], null);
  assert.ok(messages[2].routes[1]);
});
