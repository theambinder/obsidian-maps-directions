import assert from 'node:assert/strict';
import test from 'node:test';
import { AutoPreparationPolicy, autoPreparationKey, PreparationQueue, AUTO_RETRY_NO_PATH_MS, AUTO_RETRY_UNAVAILABLE_MS } from '../src/auto-preparation';

const key = (name: string, source = 'transportation-v1'): string => autoPreparationKey(name, source);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('automatic no-path results cool down for 24 hours across serialization', () => {
  let now = 1_000_000, saves = 0;
  const policy = new AutoPreparationPolicy(undefined, () => saves++, () => now);
  assert.equal(policy.shouldAttempt(key('A')), true);
  policy.record(key('A'), 'no-path');
  assert.equal(policy.shouldAttempt(key('A')), false);
  const restored = new AutoPreparationPolicy(policy.serialize(), () => saves++, () => now);
  now += AUTO_RETRY_NO_PATH_MS - 1;
  assert.equal(restored.shouldAttempt(key('A')), false);
  now++;
  assert.equal(restored.shouldAttempt(key('A')), true);
  assert.equal(saves, 1);
});

test('unavailable detail retries after 15 minutes while changed endpoints and sources are independent', () => {
  let now = 1_000_000;
  const policy = new AutoPreparationPolicy(undefined, undefined, () => now);
  policy.record(key('A'), 'unavailable');
  assert.equal(policy.shouldAttempt(key('A')), false);
  assert.equal(policy.shouldAttempt(key('B')), true);
  assert.equal(policy.shouldAttempt(key('A', 'other-source')), true);
  now += AUTO_RETRY_UNAVAILABLE_MS;
  assert.equal(policy.shouldAttempt(key('A')), true);
  assert.deepEqual(policy.serialize().attempts, []);
});

test('keys are deterministic, ordered and contain no source URLs, coordinates or note labels', () => {
  const endpoints = '[[114.1,22.3],[114.2,22.4]]', source = 'https://tiles.example/secret-token.json';
  const value = key(endpoints, source);
  assert.match(value, /^ap1:[\da-f]{16}:[\da-f]{16}$/);
  assert.equal(value, key(endpoints, source));
  assert.notEqual(value, key('[[114.2,22.4],[114.1,22.3]]', source));
  assert.notEqual(value, key(endpoints, source + 'v2'));
  assert.ok(!value.includes('https') && !value.includes('secret-token') && !value.includes('['));
});

test('malformed, expired and future persisted records cannot suppress automatic preparation', () => {
  const now = 100_000_000;
  for (const value of [undefined, null, [], { version: 99, attempts: [] }, { version: 1, attempts: 'bad' }]) {
    assert.equal(new AutoPreparationPolicy(value, undefined, () => now).shouldAttempt(key('A')), true);
  }
  const data = { version: 1, attempts: [
    null,
    { key: 'https://example/secret', outcome: 'no-path', recordedAt: now },
    { key: key('A'), outcome: 'no-path', recordedAt: now + 1 },
    { key: key('B'), outcome: 'no-path', recordedAt: now - AUTO_RETRY_NO_PATH_MS },
    { key: key('C'), outcome: 'unavailable', recordedAt: NaN },
    { key: key('D'), outcome: 'something', recordedAt: now },
  ] };
  const policy = new AutoPreparationPolicy(data, undefined, () => now);
  assert.deepEqual(policy.serialize().attempts, []);
  assert.equal(policy.shouldAttempt('bad key'), false);
  for (const name of ['A', 'B', 'C', 'D']) assert.equal(policy.shouldAttempt(key(name)), true);
});

test('attempt persistence is bounded, defensive and does not save on reads or duplicate writes', () => {
  let saves = 0, now = 10_000;
  const policy = new AutoPreparationPolicy(undefined, () => saves++, () => now);
  for (let index = 0; index < 510; index++) { now++; policy.record(key(String(index)), 'no-path'); }
  assert.equal(policy.serialize().attempts.length, 500);
  assert.equal(policy.shouldAttempt(key('0')), true);
  assert.equal(policy.shouldAttempt(key('509')), false);
  const before = saves;
  policy.record(key('509'), 'no-path');
  const serialized = policy.serialize();
  serialized.attempts[0].recordedAt = 0;
  serialized.attempts.splice(0);
  assert.equal(policy.serialize().attempts.length, 500);
  assert.equal(saves, before);
  const oversized = { version: 1, attempts: Array.from({ length: 600 }, (_, i) => ({ key: key(String(i)), outcome: 'unavailable', recordedAt: now })) };
  const restored = new AutoPreparationPolicy(oversized, () => saves++, () => now);
  assert.equal(restored.serialize().attempts.length, 500);
  assert.equal(restored.shouldAttempt(key('0')), true);
  assert.equal(saves, before);
});

test('clock rollback cannot turn a cooldown into indefinite blocking', () => {
  let now = 10_000;
  const policy = new AutoPreparationPolicy(undefined, undefined, () => now);
  policy.record(key('A'), 'no-path');
  now--;
  assert.equal(policy.shouldAttempt(key('A')), true);
});

test('the preparation queue runs only one task and continues after failure', async () => {
  const queue = new PreparationQueue(), controller = new AbortController(), first = deferred<number>();
  const started: number[] = [];
  const a = queue.run(controller.signal, () => { started.push(1); return first.promise; });
  const b = queue.run(controller.signal, async () => { started.push(2); throw Error('expected'); });
  const failure = assert.rejects(b, /expected/);
  const c = queue.run(controller.signal, async () => { started.push(3); return 3; });
  await tick();
  assert.deepEqual(started, [1]);
  first.resolve(1);
  assert.equal(await a, 1);
  await failure;
  assert.equal(await c, 3);
  assert.deepEqual(started, [1, 2, 3]);
});

test('queued cancellation rejects promptly and never starts the cancelled task', async () => {
  const queue = new PreparationQueue(), first = deferred<number>();
  const controller = new AbortController(), queued = new AbortController();
  let calls = 0;
  const a = queue.run(controller.signal, () => first.promise);
  const b = queue.run(queued.signal, async () => { calls++; return 2; });
  const failure = assert.rejects(b, { name: 'AbortError' });
  queued.abort();
  await failure;
  assert.equal(calls, 0);
  first.resolve(1);
  assert.equal(await a, 1);
  const c = await queue.run(controller.signal, async () => 3);
  assert.equal(c, 3);
});

test('an active cancelled task holds the slot until its cleanup settles', async () => {
  const queue = new PreparationQueue(), first = deferred<number>();
  const active = new AbortController(), next = new AbortController();
  let secondStarted = false;
  const a = queue.run(active.signal, () => first.promise);
  const failure = assert.rejects(a, { name: 'AbortError' });
  const b = queue.run(next.signal, async () => { secondStarted = true; return 2; });
  await tick();
  active.abort();
  await failure;
  await tick();
  assert.equal(secondStarted, false);
  first.resolve(1);
  assert.equal(await b, 2);
  assert.equal(secondStarted, true);
});

test('an idle queue starts its first task synchronously and already aborted jobs allocate no work', async () => {
  const queue = new PreparationQueue(), controller = new AbortController();
  let calls = 0;
  controller.abort();
  await assert.rejects(queue.run(controller.signal, async () => { calls++; return 1; }), { name: 'AbortError' });
  assert.equal(calls, 0);
  const fresh = new AbortController();
  const result = queue.run(fresh.signal, async () => { calls++; return 1; });
  assert.equal(calls, 1);
  assert.equal(await result, 1);
});

test('synchronous task exceptions release the queue for the next task', async () => {
  const queue = new PreparationQueue(), controller = new AbortController();
  const first = queue.run(controller.signal, () => { throw Error('synchronous'); });
  const failure = assert.rejects(first, /synchronous/);
  const next = queue.run(controller.signal, async () => 'ready');
  await failure;
  assert.equal(await next, 'ready');
});
