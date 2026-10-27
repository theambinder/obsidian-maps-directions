import assert from 'node:assert/strict';
import test from 'node:test';
import { colorDirections, normalizeLineColor, randomRouteColor, RouteColorPalette, ROUTE_COLOR_PALETTE, type RouteColorOptions } from '../src/route-colors';
import { buildDirections } from '../src/geometry';
import type { MapsMarker } from '../src/contracts';

function marker(path: string, sequence: unknown, route: string | undefined, color?: string): MapsMarker {
  const values: Record<string, unknown> = { sequence, route, color };
  return { coordinates: [35 + Number(sequence || 0) / 1000, 139], entry: {
    file: { path }, getValue: property => values[property] == null ? null : { toString: () => String(values[property]) },
  } };
}
const options: RouteColorOptions = { colorMode: 'single', color: '#7c5cff', colorProperty: 'color', groupProperty: 'route', sequenceProperty: 'sequence' };
const lineColors = (markers: MapsMarker[], mode: RouteColorOptions['colorMode'], palette?: RouteColorPalette) => colorDirections(buildDirections(markers, 'sequence', 'route'), markers, { ...options, colorMode: mode, palette }).features.map(feature => [feature.properties.route, feature.properties.lineColor]);

test('single color preserves the selected color and does not mutate input features or markers', () => {
  const markers = [marker('a', 1, 'Day 1', 'red'), marker('b', 2, 'Day 1', 'blue')];
  const data = buildDirections(markers, 'sequence', 'route');
  const before = JSON.stringify(data);
  const result = colorDirections(data, markers, options);
  assert.equal(result.features[0].properties.lineColor, '#7c5cff');
  assert.equal(JSON.stringify(data), before);
  assert.notEqual(result.features[0].properties, data.features[0].properties);
  assert.equal(result.features[0].geometry, data.features[0].geometry);
  assert.equal(markers[0].entry.getValue('color')!.toString(), 'red');
});

test('automatic colors are deterministic and a view palette preserves filtered groups', () => {
  const markers = [marker('a', 1, 'Day 1'), marker('b', 2, 'Day 1'), marker('c', 1, 'Day 2'), marker('d', 2, 'Day 2')];
  const palette = new RouteColorPalette();
  const colors = lineColors(markers, 'random', palette);
  assert.notEqual(colors[0][1], colors[1][1]);
  assert.deepEqual(lineColors([...markers].reverse(), 'random', palette), colors);
  assert.deepEqual(lineColors(markers.slice(2), 'random', palette), [colors[1]]);
  assert.deepEqual(lineColors(markers, 'random', palette), colors);
  assert.deepEqual(lineColors([...markers].reverse(), 'random'), colors);
  assert.deepEqual(lineColors(markers, 'random', new RouteColorPalette()), colors);
  assert.match(randomRouteColor('Day 1'), /^#[\da-f]{6}$/);
});

test('each route gets one property color from its first valid Sequence-ordered stop', () => {
  const markers = [marker('a3', 3, 'A', 'blue'), marker('b1', 1, 'B', 'lime'), marker('a1', 1, 'A', 'invalid'), marker('a2', 2, 'A', 'rgb(255, 0, 0)'), marker('b2', 2, 'B', 'yellow')];
  assert.deepEqual(lineColors(markers, 'property'), [['A', '#ff0000'], ['A', '#ff0000'], ['B', '#00ff00']]);
  assert.deepEqual(lineColors([...markers].reverse(), 'property'), lineColors(markers, 'property'));
});

test('equal Sequence property colors resolve by note path and missing/invalid values fall back', () => {
  const markers = [marker('z', 1, 'A', 'blue'), marker('a', 1, 'A', '#f80'), marker('other1', 1, 'B'), marker('other2', 2, 'B', 'not a color')];
  markers[0].coordinates[1] += 0.001;
  assert.deepEqual(lineColors(markers, 'property'), [['A', '#ff8800'], ['B', '#7c5cff']]);
  const data = buildDirections(markers, 'sequence', 'route');
  assert.ok(colorDirections(data, markers, { ...options, colorMode: 'property', colorProperty: null }).features.every(feature => feature.properties.lineColor === '#7c5cff'));
});

test('property groups preserve exact group values and ignore unsequenced color-only notes', () => {
  const markers = [marker('not ordered', undefined, ' A ', 'red'), marker('a', 1, ' A ', 'green'), marker('b', 2, ' A ', 'blue')];
  assert.deepEqual(lineColors(markers, 'property'), [[' A ', '#008000']]);
});

test('blank groups and ungrouped routes remain consistent and unavailable color formulas are ignored', () => {
  const markers = [marker('a', 1, undefined, 'red'), marker('b', 2, undefined, 'blue'), marker('c', 3, undefined)];
  const original = markers[0].entry.getValue;
  markers[0].entry.getValue = property => { if (property === 'color') throw Error('formula failed'); return original(property); };
  assert.deepEqual(lineColors(markers, 'property'), [['', '#0000ff'], ['', '#0000ff']]);
  const ungrouped = colorDirections(buildDirections(markers, 'sequence', null), markers, { ...options, colorMode: 'property', groupProperty: null });
  assert.ok(ungrouped.features.every(feature => feature.properties.lineColor === '#0000ff'));
});

test('color parser normalizes supported hex, RGB, HSL and named colors to opaque RGB', () => {
  const cases: Record<string, string> = {
    '#AbC': '#aabbcc', '#ABCD': '#aabbcc', '#FF8800': '#ff8800', '#ff880080': '#ff8800',
    ' RGB(255, 128, 0) ': '#ff8000', 'rgb(100% 0% 0% / 50%)': '#ff0000',
    'rgba(0, 128, 255, 0.4)': '#0080ff', 'hsl(120 100% 50%)': '#00ff00',
    'hsla(240, 100%, 50%, 0.5)': '#0000ff', 'hsl(0.5turn 100% 50%)': '#00ffff',
    'hsl(200grad 100% 50%)': '#00ffff', 'RebeccaPurple': '#663399', 'orange': '#ffa500',
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(normalizeLineColor(input), expected, input);
  for (const input of ['', '#12', '#gggggg', 'url(example)', 'rgb(1, 2)', 'rgb(1 2 3 / bad)', 'hsl(1 2 3)', 'rgb(NaN 0 0)', 'transparent']) assert.equal(normalizeLineColor(input), null, input);
});

test('native parser extensions are normalized and cannot inject invalid feature color values', () => {
  const markers = [marker('a', 1, 'A', 'custom-color'), marker('b', 2, 'A')];
  const data = buildDirections(markers, 'sequence', 'route');
  const result = colorDirections(data, markers, { ...options, colorMode: 'property', normalizeColor: value => value === 'custom-color' ? 'rgb(1, 2, 3)' : null });
  assert.equal(result.features[0].properties.lineColor, '#010203');
  const failed = colorDirections(data, markers, { ...options, colorMode: 'property', normalizeColor: () => { throw Error('unavailable'); } });
  assert.equal(failed.features[0].properties.lineColor, '#7c5cff');
});


test('four neighboring date groups use distinct categorical families rather than similar hash shades', () => {
  const groups = ['09-09, Wed', '09-10, Thu', '09-11, Fri', '09-12, Sat'];
  const markers = groups.flatMap((group, index) => [marker(`${index}-a`, 1, group), marker(`${index}-b`, 2, group)]);
  const colors = lineColors(markers, 'random').map(row => String(row[1]));
  assert.deepEqual(colors, ROUTE_COLOR_PALETTE.slice(0, 4));
  assert.equal(new Set(colors).size, 4);
  const rgb = (color: string) => [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
  for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) {
    const a = rgb(colors[i]), b = rgb(colors[j]);
    assert.ok(Math.hypot(...a.map((channel, k) => channel - b[k])) > 100, `${groups[i]} and ${groups[j]} must remain visibly distinct`);
  }
});

test('new groups receive unused contrasting colors without recoloring existing or hidden groups', () => {
  const palette = new RouteColorPalette();
  const initial = palette.assign(['D', 'B']);
  const expanded = palette.assign(['A', 'B', 'C', 'D']);
  assert.equal(expanded.get('B'), initial.get('B'));
  assert.equal(expanded.get('D'), initial.get('D'));
  assert.equal(new Set(expanded.values()).size, 4);
  palette.assign(['B']);
  const added = palette.assign(['B', 'E']);
  assert.equal(added.get('B'), initial.get('B'));
  assert.ok(![...expanded.values()].includes(added.get('E')!));
  const restored = palette.assign(['A', 'B', 'C', 'D', 'E']);
  for (const [group, color] of expanded) assert.equal(restored.get(group), color);
});

test('large palettes remain deterministic with unique RGB values and do not expose mutable state', () => {
  const groups = Array.from({ length: 90 }, (_, index) => `Route ${String(index).padStart(3, '0')}`);
  const palette = new RouteColorPalette();
  const colors = palette.assign(groups);
  assert.equal(new Set(colors.values()).size, groups.length);
  assert.deepEqual(palette.assign([...groups].reverse()), new Map([...colors].reverse()));
  assert.deepEqual(new RouteColorPalette().assign([...groups].reverse()), new Map([...colors].reverse()));
  const saved = colors.get(groups[0]);
  (colors as Map<string, string>).set(groups[0], '#000000');
  assert.equal(palette.assign([groups[0]]).get(groups[0]), saved);
  for (let index = 0; index < 400; index++) palette.assign([groups[0], `Other ${index}`]);
  assert.equal(palette.assign([groups[0]]).get(groups[0]), saved);
});

test('road, fallback and access features share the same automatic route color', () => {
  const markers = [marker('a', 1, 'A'), marker('b', 2, 'A'), marker('c', 1, 'B'), marker('d', 2, 'B')];
  const data = buildDirections(markers, 'sequence', 'route');
  data.features.push({ ...data.features[0], properties: { ...data.features[0].properties, connectionKind: 'connector' } });
  data.features[0].properties.connectionKind = 'road';
  data.features[1].properties.connectionKind = 'fallback';
  const colored = colorDirections(data, markers, { ...options, colorMode: 'random', palette: new RouteColorPalette() });
  assert.equal(colored.features[0].properties.lineColor, colored.features[2].properties.lineColor);
  assert.notEqual(colored.features[0].properties.lineColor, colored.features[1].properties.lineColor);
  assert.ok(data.features.every(feature => feature.properties.lineColor === undefined));
});


test('hidden palette history does not make a newly visible route blend with the current one', () => {
  const palette = new RouteColorPalette();
  palette.assign(['Keep']);
  for (let index = 0; index < 400; index++) palette.assign(['Keep', `Other ${index}`]);
  const colors = palette.assign(['Keep', 'Newly visible']);
  const a = [1, 3, 5].map(offset => Number.parseInt(colors.get('Keep')!.slice(offset, offset + 2), 16));
  const b = [1, 3, 5].map(offset => Number.parseInt(colors.get('Newly visible')!.slice(offset, offset + 2), 16));
  assert.ok(Math.hypot(...a.map((channel, index) => channel - b[index])) > 120);
});
