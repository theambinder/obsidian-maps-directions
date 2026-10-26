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
});
