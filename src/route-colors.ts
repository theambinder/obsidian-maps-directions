import type { FeatureCollection, MapsMarker } from './contracts';

export interface RouteColorOptions {
  colorMode: 'single' | 'random' | 'property';
  color: string;
  colorProperty: string | null;
  groupProperty: string | null;
  sequenceProperty: string | null;
  /** Optional native CSS parser for color syntaxes beyond the built-in subset. */
  normalizeColor?: (value: string) => string | null;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', violet: '#ee82ee', pink: '#ffc0cb',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', lime: '#00ff00', aqua: '#00ffff',
  cyan: '#00ffff', teal: '#008080', navy: '#000080', maroon: '#800000', olive: '#808000',
  fuchsia: '#ff00ff', magenta: '#ff00ff', coral: '#ff7f50', tomato: '#ff6347', gold: '#ffd700',
  brown: '#a52a2a', rebeccapurple: '#663399', turquoise: '#40e0d0', indigo: '#4b0082',
  salmon: '#fa8072', darkred: '#8b0000', darkblue: '#00008b', darkgreen: '#006400',
  lightblue: '#add8e6', lightgreen: '#90ee90', aliceblue: '#f0f8ff', transparent: '',
};
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const hex = (channels: number[]): string => '#' + channels.map(channel => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0')).join('');
const number = (text: string): number | null => {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

function hsl(hue: number, saturation: number, lightness: number): string {
  const h = ((hue % 360) + 360) % 360 / 60;
  const s = clamp(saturation, 0, 1), l = clamp(lightness, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
  const channels = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return hex(channels.map(channel => (channel + m) * 255));
}

/** Normalize common CSS colors. Opacity comes from the separate line-opacity setting. */
export function normalizeLineColor(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (Object.hasOwn(NAMED, text)) return NAMED[text] || null;
  const literal = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(text)?.[1];
  if (literal) return literal.length < 5 ? '#' + [...literal.slice(0, 3)].map(channel => channel + channel).join('') : '#' + literal.slice(0, 6);
  const fn = /^(rgb|rgba|hsl|hsla)\(([^()]*)\)$/.exec(text);
  if (!fn) return null;
  const body = fn[2].trim();
  let parts: string[], alpha: string | undefined;
  if (body.includes(',')) {
    if (body.includes('/')) return null;
    const components = body.split(/\s*,\s*/);
    if (components.length !== 3 && components.length !== 4) return null;
    parts = components.slice(0, 3);
    alpha = components[3];
  } else {
    const components = body.split(/\s*\/\s*/);
    if (components.length > 2) return null;
    parts = components[0].trim().split(/\s+/);
    alpha = components[1];
    if (parts.length !== 3) return null;
  }
  if (alpha !== undefined && number(alpha.endsWith('%') ? alpha.slice(0, -1) : alpha) === null) return null;
  if (fn[1].startsWith('rgb')) {
    const channels = parts.map(part => {
      const value = number(part.endsWith('%') ? part.slice(0, -1) : part);
      return value === null ? null : part.endsWith('%') ? value * 255 / 100 : value;
    });
    return channels.some(channel => channel === null) ? null : hex(channels as number[]);
  }
  const hueParts = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/.exec(parts[0]);
  if (!hueParts || !parts[1].endsWith('%') || !parts[2].endsWith('%')) return null;
  const rawHue = number(hueParts[1]);
  const saturation = number(parts[1].slice(0, -1)), lightness = number(parts[2].slice(0, -1));
  if (rawHue === null || saturation === null || lightness === null) return null;
  const hue = rawHue * (hueParts[2] === 'turn' ? 360 : hueParts[2] === 'rad' ? 180 / Math.PI : hueParts[2] === 'grad' ? 0.9 : 1);
  return Number.isFinite(hue) ? hsl(hue, saturation / 100, lightness / 100) : null;
}

/** Pseudorandom but stable per group, including across reloads and filtered views. */
export function randomRouteColor(group: string): string {
  let hash = 2166136261;
  for (let index = 0; index < group.length; index++) hash = Math.imul(hash ^ group.charCodeAt(index), 16777619);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash = (hash ^ hash >>> 16) >>> 0;
  return hsl(hash % 360, (68 + (hash >>> 9) % 16) / 100, (54 + (hash >>> 17) % 10) / 100);
}

function propertyText(marker: MapsMarker, property: string, trim = true): string | null {
  try {
    const text = marker.entry.getValue(property)?.toString();
    return text === undefined ? null : trim ? text.trim() : text;
  }
  catch { return null; } // An unavailable color formula must not suspend the map.
}

/** Add per-route colors without changing the markers, geometry, or incoming data. */
export function colorDirections(data: FeatureCollection, markers: readonly MapsMarker[], options: RouteColorOptions): FeatureCollection {
  const parse = (text: string): string | null => {
    const common = normalizeLineColor(text);
    if (common) return common;
    try {
      const native = options.normalizeColor?.(text);
      return native ? normalizeLineColor(native) : null;
    } catch { return null; }
  };
  const fallback = parse(options.color) ?? '#7c5cff';
  const colors = new Map<string, string>();
  if (options.colorMode === 'property' && options.colorProperty && options.sequenceProperty) {
    const points = markers.flatMap((marker, index) => {
      const [lat, lon] = marker.coordinates;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return [];
      const text = propertyText(marker, options.sequenceProperty!);
      const sequence = text ? Number(text) : NaN;
      if (!Number.isFinite(sequence)) return [];
      const group = options.groupProperty ? propertyText(marker, options.groupProperty, false) ?? '' : '';
      return [{ marker, sequence, group, index }];
    });
    points.sort((a, b) => a.sequence - b.sequence || (a.marker.entry.file.path < b.marker.entry.file.path ? -1 : a.marker.entry.file.path > b.marker.entry.file.path ? 1 : a.index - b.index));
    for (const { marker, group } of points) {
      if (colors.has(group)) continue;
      const text = propertyText(marker, options.colorProperty);
      if (!text) continue;
      const color = parse(text);
      if (color) colors.set(group, color);
    }
  }
  return {
    type: 'FeatureCollection',
    features: data.features.map(feature => {
      const group = String(feature.properties.route ?? '');
      const lineColor = options.colorMode === 'random' ? randomRouteColor(group) : options.colorMode === 'property' ? colors.get(group) ?? fallback : fallback;
      return { ...feature, properties: { ...feature.properties, lineColor } };
    }),
  };
}
