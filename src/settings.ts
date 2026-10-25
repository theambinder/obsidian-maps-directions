import type { BasesAllOptions } from 'obsidian';
import type { ViewConfigLike } from './contracts';

export const KEYS = {
  enabled: 'directionsEnabled', sequence: 'directionsSequence', group: 'directionsRoute',
  arrows: 'directionsArrows', color: 'directionsColor', width: 'directionsWidth',
  opacity: 'directionsOpacity', arrowSize: 'directionsArrowSize',
} as const;

export const LINE_COLORS: Record<string, string> = {
  '#7c5cff': 'Violet', '#2583e8': 'Blue', '#159b80': 'Green',
  '#ef8733': 'Orange', '#e04f65': 'Red', '#e8c547': 'Yellow',
};

export interface DirectionOptions {
  enabled: boolean;
  sequenceProperty: string | null;
  groupProperty: string | null;
  arrows: boolean;
  color: string;
  width: number;
  opacity: number;
  arrowSize: number;
}

export function readOptions(config: ViewConfigLike): DirectionOptions {
  const number = (key: string, fallback: number, min: number, max: number): number => {
    const v = config.get(key);
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const color = config.get(KEYS.color);
  return {
    enabled: config.get(KEYS.enabled) === true,
    sequenceProperty: config.getAsPropertyId(KEYS.sequence) ?? 'note.Sequence',
    groupProperty: config.getAsPropertyId(KEYS.group),
    arrows: config.get(KEYS.arrows) !== false,
    color: typeof color === 'string' && Object.hasOwn(LINE_COLORS, color) ? color : '#7c5cff',
    width: number(KEYS.width, 3, 1, 8),
    opacity: number(KEYS.opacity, 0.85, 0.1, 1),
    arrowSize: number(KEYS.arrowSize, 1, 0.5, 2),
  };
}

export function directionSettings(): BasesAllOptions[] {
  return [
    { type: 'group', displayName: 'Directions', items: [
      { type: 'toggle', key: KEYS.enabled, displayName: 'Connect markers', default: false },
      { type: 'property', key: KEYS.sequence, displayName: 'Sequence property', default: 'note.Sequence', placeholder: 'Sequence', filter: p => !p.startsWith('file.') },
      { type: 'property', key: KEYS.group, displayName: 'Separate routes by', placeholder: 'Optional property, e.g. Route', filter: p => !p.startsWith('file.') },
      { type: 'toggle', key: KEYS.arrows, displayName: 'Show direction arrows', default: true },
    ] },
    { type: 'group', displayName: 'Connection style', items: [
      { type: 'dropdown', key: KEYS.color, displayName: 'Line color', default: '#7c5cff', options: LINE_COLORS },
      { type: 'slider', key: KEYS.width, displayName: 'Line width', default: 3, min: 1, max: 8, step: 1 },
      { type: 'slider', key: KEYS.opacity, displayName: 'Line opacity', default: 0.85, min: 0.1, max: 1, step: 0.05 },
      { type: 'slider', key: KEYS.arrowSize, displayName: 'Arrow size', default: 1, min: 0.5, max: 2, step: 0.1 },
    ] },
  ];
}
