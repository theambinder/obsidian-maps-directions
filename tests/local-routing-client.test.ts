import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalRoutingClient } from '../src/local-routing-client';
import type { RoadSnapshot } from '../src/local-roads';
import type { RoutingJob, RoutingResult } from '../src/routing-protocol';

const snapshot: RoadSnapshot = {
  key: 'loaded-roads', state: 'ready', sources: ['openmaptiles'],
  features: [{ geometry: { type: 'LineString', coordinates: [[139, 35], [139.001, 35]] }, properties: { class: 'minor' } }],
};
const legs: RoutingJob['legs'] = [{ from: [139, 35], to: [139.001, 35] }];
const result = (id: number): RoutingResult => ({
  id, routes: [{ coordinates: [[139, 35], [139.001, 35]], distance: 91 }],
  stats: { nodes: 2, edges: 1, truncated: false },
});

function mockRuntime() {
  const targets: Array<[object, string]> = [
    [globalThis, 'Worker'], [globalThis, '__LOCAL_ROUTING_WORKER__'],
    [URL, 'createObjectURL'], [URL, 'revokeObjectURL'],
  ];
  const saved = targets.map(([target, key]) => ({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) }));
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const workers: FakeWorker[] = [];
  let creationFailure: Error | null = null;
  let postFailure = false;
  class FakeWorker {
    onmessage: ((event: MessageEvent<RoutingResult>) => void) | null = null;
    onerror: (() => void) | null = null;
    readonly messages: RoutingJob[] = [];
    terminateCount = 0;
    constructor(readonly url: string) {
      if (creationFailure) throw creationFailure;
      workers.push(this);
    }
    postMessage(job: RoutingJob): void {
      if (postFailure) throw new Error('Could not clone routing job');
      this.messages.push(job);
    }
    terminate(): void { this.terminateCount++; }
    reply(message: RoutingResult): void { this.onmessage?.({ data: message } as MessageEvent<RoutingResult>); }
    fail(): void { this.onerror?.(); }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
  Object.defineProperty(globalThis, '__LOCAL_ROUTING_WORKER__', { configurable: true, writable: true, value: '/* bundled local routing worker */' });
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: (blob: Blob) => {
    blobs.push(blob);
    return `blob:local-routing-${blobs.length}`;
  } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: (url: string) => revoked.push(url) });
  return {
    blobs, revoked, workers,
    setCreationFailure(error: Error | null): void { creationFailure = error; },
    setPostFailure(value: boolean): void { postFailure = value; },
    restore(): void {
      for (const { target, key, descriptor } of saved) {
        if (descriptor) Object.defineProperty(target, key, descriptor);
        else Reflect.deleteProperty(target, key);
      }
    },
  };
}

test('cancelling pending local routing rejects the job and releases the worker and Blob URL once', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    const pending = client.route(snapshot, legs);
    const rejected = assert.rejects(pending, /Local road search stopped/);
    const worker = runtime.workers[0];
    assert.equal(runtime.blobs[0].type, 'text/javascript');
    assert.equal(await runtime.blobs[0].text(), '/* bundled local routing worker */');
    assert.deepEqual(worker.messages[0], { id: 1, graphKey: snapshot.key, features: snapshot.features, legs });
    client.cancel();
    await rejected;
    assert.equal(worker.terminateCount, 1);
    assert.deepEqual(runtime.revoked, [worker.url]);
    // A queued reply after cancellation cannot revive the cancelled request.
    worker.reply(result(1));
    client.cancel();
    assert.equal(worker.terminateCount, 1);
    assert.deepEqual(runtime.revoked, [worker.url]);
  } finally { client.cancel(); runtime.restore(); }
});

test('wrong-id replies are ignored and the matching reply resolves only its own job', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    let settled = false;
    const pending = client.route(snapshot, legs).then(value => { settled = true; return value; });
    const worker = runtime.workers[0];
    const id = worker.messages[0].id;
    worker.reply(result(id + 100));
    await Promise.resolve();
    assert.equal(settled, false);
    worker.reply(result(id));
    assert.deepEqual(await pending, result(id));
    assert.equal(worker.terminateCount, 0);
    client.cancel();
    assert.equal(worker.terminateCount, 1);
    assert.deepEqual(runtime.revoked, [worker.url]);
  } finally { client.cancel(); runtime.restore(); }
});

test('a replacement job cancels its predecessor and ignores the old worker reply', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    const first = client.route(snapshot, legs);
    const firstRejected = assert.rejects(first, /Local road search stopped/);
    const oldWorker = runtime.workers[0];
    let secondSettled = false;
    const second = client.route(snapshot, legs).then(value => { secondSettled = true; return value; });
    const worker = runtime.workers[1];
    await firstRejected;
    assert.equal(oldWorker.terminateCount, 1);
    assert.deepEqual(runtime.revoked, [oldWorker.url]);
    oldWorker.reply(result(oldWorker.messages[0].id));
    await Promise.resolve();
    assert.equal(secondSettled, false);
    worker.reply(result(worker.messages[0].id));
    assert.deepEqual(await second, result(worker.messages[0].id));
  } finally { client.cancel(); runtime.restore(); }
});

test('a late error from a replaced worker cannot cancel the current routing job', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    const first = client.route(snapshot, legs);
    const firstRejected = assert.rejects(first, /Local road search stopped/);
    const oldWorker = runtime.workers[0];
    const second = client.route(snapshot, legs);
    const worker = runtime.workers[1];
    await firstRejected;
    // A parent-thread error event may already have been queued before termination.
    oldWorker.fail();
    assert.equal(worker.terminateCount, 0);
    assert.deepEqual(runtime.revoked, [oldWorker.url]);
    worker.reply(result(worker.messages[0].id));
    assert.deepEqual(await second, result(worker.messages[0].id));
  } finally { client.cancel(); runtime.restore(); }
});

test('a worker error rejects pending work, releases its resources, and allows a new worker', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    const pending = client.route(snapshot, legs);
    const rejected = assert.rejects(pending, /Local road search stopped/);
    const failedWorker = runtime.workers[0];
    failedWorker.fail();
    await rejected;
    assert.equal(failedWorker.terminateCount, 1);
    assert.deepEqual(runtime.revoked, [failedWorker.url]);
    const next = client.route(snapshot, legs);
    const worker = runtime.workers[1];
    assert.notEqual(worker.url, failedWorker.url);
    worker.reply(result(worker.messages[0].id));
    assert.deepEqual(await next, result(worker.messages[0].id));
  } finally { client.cancel(); runtime.restore(); }
});

test('a Worker constructor failure revokes the created Blob URL and leaves the client reusable', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    const failure = new Error('Workers are unavailable');
    runtime.setCreationFailure(failure);
    await assert.rejects(client.route(snapshot, legs), error => error === failure);
    assert.equal(runtime.workers.length, 0);
    assert.equal(runtime.blobs.length, 1);
    assert.deepEqual(runtime.revoked, ['blob:local-routing-1']);
    runtime.setCreationFailure(null);
    const next = client.route(snapshot, legs);
    const worker = runtime.workers[0];
    assert.equal(worker.url, 'blob:local-routing-2');
    worker.reply(result(worker.messages[0].id));
    assert.deepEqual(await next, result(worker.messages[0].id));
  } finally { client.cancel(); runtime.restore(); }
});

test('postMessage failure rejects the job and releases the worker and Blob URL', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    runtime.setPostFailure(true);
    await assert.rejects(client.route(snapshot, legs), /Local road search stopped/);
    const worker = runtime.workers[0];
    assert.equal(worker.terminateCount, 1);
    assert.deepEqual(runtime.revoked, [worker.url]);
  } finally { client.cancel(); runtime.restore(); }
});

test('a worker-reported search error rejects the request and does not resolve partial routes', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  try {
    const pending = client.route(snapshot, legs);
    const rejected = assert.rejects(pending, /Local road search failed/);
    const worker = runtime.workers[0];
    worker.reply({ ...result(worker.messages[0].id), error: 'Local road search failed.' });
    await rejected;
    client.cancel();
    assert.equal(worker.terminateCount, 1);
    assert.deepEqual(runtime.revoked, [worker.url]);
  } finally { client.cancel(); runtime.restore(); }
});

test('configured worker timeouts honor processing modes and keep invalid values from changing the budget', async () => {
  const runtime = mockRuntime();
  const client = new LocalRoutingClient();
  const originalSetTimeout = globalThis.setTimeout;
  const scheduled: number[] = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    scheduled.push(args[1] ?? 0);
    return originalSetTimeout(...args);
  }) as typeof setTimeout;
  try {
    for (const timeout of [NaN, 20000, Infinity, 1, 100000]) {
      client.configure(timeout);
      const pending = client.route(snapshot, legs);
      const worker = runtime.workers[0];
      worker.reply(result(worker.messages.at(-1)!.id));
      await pending;
    }
    assert.deepEqual(scheduled, [8000, 20000, 20000, 1000, 60000]);
  } finally { client.cancel(); globalThis.setTimeout = originalSetTimeout; runtime.restore(); }
});
