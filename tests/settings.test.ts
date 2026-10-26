import assert from 'node:assert/strict';
import test from 'node:test';
import { directionSettings, KEYS, readOptions } from '../src/settings';
import type { ViewConfigLike } from '../src/contracts';

function config(value?: unknown): ViewConfigLike {
  return {
    get: key => key === KEYS.sequence ? value : undefined,
    getAsPropertyId: key => key === KEYS.sequence && typeof value === 'string' && value.startsWith('note.') && value.length > 5 ? value : null,
  };
}

test('a missing, cleared or invalid Sequence property stays unselected', () => {
  for (const value of [undefined, null, '', '   ', 0, false, 'not a property']) {
    assert.equal(readOptions(config(value)).sequenceProperty, null);
  }
  assert.equal(readOptions(config('note.Sequence')).sequenceProperty, 'note.Sequence');
  assert.equal(readOptions(config('note.Order')).sequenceProperty, 'note.Order');
});

test('Sequence has no fallback default and Route mode belongs to Directions', () => {
  const groups = directionSettings();
  assert.deepEqual(groups.map(group => group.displayName), ['Directions', 'Connection style']);
  const directions = groups[0];
  assert.ok(directions.type === 'group');
  const sequence = directions.items.find(option => option.key === KEYS.sequence)!;
  assert.equal(Object.hasOwn(sequence, 'default'), false);
  assert.ok(directions.items.some(option => option.key === KEYS.routeMode));
});
