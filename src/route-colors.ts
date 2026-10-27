import type { FeatureCollection, MapsMarker } from './contracts';

export interface RouteColorOptions {
  colorMode: 'single' | 'random' | 'property';
  color: string;
  colorProperty: string | null;
  groupProperty: string | null;
  sequenceProperty: string | null;
  /** Optional native CSS parser for color syntaxes beyond the built-in subset. */
  normalizeColor?: (value: string) => string | null;
  /** Keep one allocator per open view so filters cannot recolor existing groups. */
  palette?: RouteColorPalette;
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

/** The first four families stay distinct even for similar route names or dates. */
export const ROUTE_COLOR_PALETTE = [
  '#2583e8', '#ef8733', '#159b80', '#cf4f9b',
  '#d7ab16', '#9a66dc', '#d64c4c', '#22b5cc',
  '#7fa128', '#a66a38', '#526c8d', '#ed6d9b',
  '#0d7991', '#704bb0', '#bc7935', '#3a9562',
] as const;

/** OKLab distances avoid treating two neighboring RGB shades as different families. */
function perceptualColor(color: string): [number, number, number] {
  const linear = [1, 3, 5].map(offset => {
    const value = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * linear[0] + 0.5363325363 * linear[1] + 0.0514459929 * linear[2]);
  const m = Math.cbrt(0.2119034982 * linear[0] + 0.6806995451 * linear[1] + 0.1073969566 * linear[2]);
  const s = Math.cbrt(0.0883024619 * linear[0] + 0.2817188376 * linear[1] + 0.6299787005 * linear[2]);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
const distanceSquared = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0);
const CANDIDATE_COLORS: readonly string[] = [...new Set<string>([
  ...ROUTE_COLOR_PALETTE,
  ...Array.from({ length: 48 }, (_, index) => hsl(index * 137.507764, 0.72, [0.43, 0.56, 0.68][index % 3])),
])];
const CANDIDATE_POINTS = new Map(CANDIDATE_COLORS.map(color => [color, perceptualColor(color)]));

/** Categorical colors are chosen jointly, while assignments survive view filtering. */
export class RouteColorPalette {
  private readonly assignments = new Map<string, string>();
  private readonly historyLimit = 256;

  assign(groups: readonly string[]): ReadonlyMap<string, string> {
    const active = new Set(groups);
    const unknown = [...active].filter(group => !this.assignments.has(group)).sort();
    // Retain every currently displayed group; evict only old, hidden history.
    const limit = Math.max(this.historyLimit, active.size);
    for (const group of this.assignments.keys()) {
      if (this.assignments.size + unknown.length <= limit) break;
      if (!active.has(group)) this.assignments.delete(group);
    }
    const used = new Set(this.assignments.values());
    const visible = new Set([...this.assignments].filter(([group]) => active.has(group)).map(([, color]) => color));
    for (const group of unknown) {
      let color: string;
      if (used.size < 4) color = ROUTE_COLOR_PALETTE.find(candidate => !used.has(candidate))!;
      else {
        const points = [...visible].map(perceptualColor);
        let best = -1;
        color = '';
        const candidates = [...CANDIDATE_COLORS,
          ...Array.from({ length: 64 }, (_, index) => randomRouteColor(`route-palette:${this.assignments.size + index}`))];
        for (const candidate of candidates) {
          if (used.has(candidate)) continue;
          const point = CANDIDATE_POINTS.get(candidate) ?? perceptualColor(candidate);
          const separation = points.length ? Math.min(...points.map(other => distanceSquared(point, other))) : 0;
          if (separation > best) { best = separation; color = candidate; }
        }
        // Very large legends exhaust categorical colors; keep exact RGB values unique.
        for (let index = this.assignments.size; !color || used.has(color); index++) color = randomRouteColor(`route-palette:${index}`);
      }
      this.assignments.set(group, color);
      used.add(color);
      visible.add(color);
    }
    // Refresh only recency, never the allocated color.
    const result = new Map<string, string>();
    for (const group of active) {
      const color = this.assignments.get(group)!;
      this.assignments.delete(group);
      this.assignments.set(group, color);
      result.set(group, color);
    }
    return result;
  }
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
  const automatic = options.colorMode === 'random' ? (options.palette ?? new RouteColorPalette()).assign(data.features.map(feature => String(feature.properties.route ?? ''))) : null;
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
      const lineColor = options.colorMode === 'random' ? automatic!.get(group)! : options.colorMode === 'property' ? colors.get(group) ?? fallback : fallback;
      return { ...feature, properties: { ...feature.properties, lineColor } };
    }),
  };
}
