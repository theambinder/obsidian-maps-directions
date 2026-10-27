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
  assert.deepEqual(groups.map(group => group.displayName), ['Directions']);
  const directions = groups[0];
  assert.ok(directions.type === 'group');
  const sequence = directions.items.find(option => option.key === KEYS.sequence)!;
  assert.equal(Object.hasOwn(sequence, 'default'), false);
  assert.ok(directions.items.some(option => option.key === KEYS.routeMode));
});

test('color modes retain the single-color default and preserve an optional property selection', () => {
  const values: Record<string, unknown> = {};
  const options: ViewConfigLike = {
    get: key => values[key],
    getAsPropertyId: key => typeof values[key] === 'string' && values[key].startsWith('note.') ? values[key] as string : null,
  };
  assert.equal(readOptions(options).colorMode, 'single');
  assert.equal(readOptions(options).colorProperty, null);
  assert.equal(readOptions(options).color, '#7c5cff');
  values[KEYS.colorMode] = 'random';
  assert.equal(readOptions(options).colorMode, 'random');
  values[KEYS.colorMode] = 'property';
  values[KEYS.colorProperty] = 'note.RouteColor';
  assert.equal(readOptions(options).colorMode, 'property');
  assert.equal(readOptions(options).colorProperty, 'note.RouteColor');
  values[KEYS.colorMode] = 'unknown';
  assert.equal(readOptions(options).colorMode, 'single');
});

test('color-specific controls follow the current mode without rebuilding the settings definitions', () => {
  let mode: unknown;
  const groups = directionSettings({ get: key => key === KEYS.colorMode ? mode : undefined });
  const directions = groups[0];
  assert.ok(directions.type === 'group');
  const single = directions.items.find(option => option.key === KEYS.color)!;
  const property = directions.items.find(option => option.key === KEYS.colorProperty)!;
  assert.equal(Object.hasOwn(property, 'default'), false);
  assert.equal(single.shouldHide?.(), false);
  assert.equal(property.shouldHide?.(), true);
  mode = 'random';
  assert.equal(single.shouldHide?.(), true);
  assert.equal(property.shouldHide?.(), true);
  mode = 'property';
  assert.equal(single.shouldHide?.(), true);
  assert.equal(property.shouldHide?.(), false);
  mode = 'single';
  assert.equal(single.shouldHide?.(), false);
  assert.equal(property.shouldHide?.(), true);
  const propertyOption = property;
  assert.ok(propertyOption.type === 'property');
  assert.equal(propertyOption.filter?.('note.RouteColor'), true);
  assert.equal(propertyOption.filter?.('formula.RouteColor'), true);
  assert.equal(propertyOption.filter?.('file.name'), false);
});

test('automatic road preparation is enabled by default and respects an explicit opt-out', () => {
  const values: Record<string, unknown> = {};
  const options: ViewConfigLike = { get: key => values[key], getAsPropertyId: () => null };
  assert.equal(readOptions(options).autoPrepare, true);
  values[KEYS.autoPrepare] = false;
  assert.equal(readOptions(options).autoPrepare, false);
  values[KEYS.autoPrepare] = true;
  assert.equal(readOptions(options).autoPrepare, true);
  values[KEYS.autoPrepare] = 'invalid';
  assert.equal(readOptions(options).autoPrepare, true);
});

test('automatic preparation setting stays in Directions and follows the current route mode', () => {
  let mode: unknown;
  const [directions] = directionSettings({ get: key => key === KEYS.routeMode ? mode : undefined });
  assert.ok(directions.type === 'group');
  const automatic = directions.items.find(option => option.key === KEYS.autoPrepare)!;
  assert.equal(automatic.type, 'toggle');
  assert.equal(automatic.displayName, 'Automatically prepare roads');
  assert.equal('default' in automatic && automatic.default, true);
  assert.equal(automatic.shouldHide?.(), true);
  mode = 'local';
  assert.equal(automatic.shouldHide?.(), false);
  mode = 'straight';
  assert.equal(automatic.shouldHide?.(), true);
});
