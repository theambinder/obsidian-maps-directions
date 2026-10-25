import type { MapLike, MapsViewLike, OverlayLike } from './contracts';
import { buildDirections } from './geometry';
import { readOptions } from './settings';

export const RESOURCE_PREFIX = 'obsidian-maps-directions-';
const sessionId = Date.now().toString(36);
let instanceId = 0;

/** A right-facing chevron. Its direction follows the GeoJSON line direction. */
export function createArrowImage(color: string): { width: number; height: number; data: Uint8Array } {
  const width = 64;
  const height = 48;
  const data = new Uint8Array(width * height * 4);
  const rgb = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16));
  const polygon = [[16, 4], [28, 4], [52, 24], [28, 44], [16, 44], [40, 24]];
  const inside = (x: number, y: number): boolean => {
    let hit = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const [xi, yi] = polygon[i];
      const [xj, yj] = polygon[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let coverage = 0;
      for (const dy of [0.25, 0.75]) for (const dx of [0.25, 0.75]) if (inside(x + dx, y + dy)) coverage++;
      if (!coverage) continue;
      const offset = (y * width + x) * 4;
      data[offset] = rgb[0];
      data[offset + 1] = rgb[1];
      data[offset + 2] = rgb[2];
      data[offset + 3] = Math.round(255 * coverage / 4);
    }
  }
  return { width, height, data };
}

/** Adds directions to official Maps without replacing any Maps renderer. */
export class DirectionsOverlay implements OverlayLike {
  private readonly id = `${RESOURCE_PREFIX}${sessionId}-${++instanceId}`;
  private readonly sourceId = `${this.id}-source`;
  private readonly lineId = `${this.id}-lines`;
  private readonly arrowId = `${this.id}-arrows`;
  private readonly imageId = `${this.id}-chevron`;
  private map: MapLike | null = null;
  private dataSignature: string | null = null;
  private styleSignature: string | null = null;
  private imageColor: string | null = null;
  private updating = false;
  private destroyed = false;
  private suspended = false;
  private readonly onMapEvent = (): void => this.update();

  constructor(private readonly view: MapsViewLike, private readonly onError: (error: unknown) => void) {}

  update(): void {
    if (this.destroyed || this.suspended || this.updating) return;
    this.updating = true;
    try {
      const options = readOptions(this.view.config);
      const map = this.view.map;
      if (!options.enabled || !options.sequenceProperty || !map) {
        this.releaseMap();
        return;
      }
      const data = buildDirections(this.view.markerManager.markers, options.sequenceProperty, options.groupProperty);
      if (data.features.length === 0) {
        this.releaseMap();
        return;
      }
      if (this.map !== map) {
        this.releaseMap();
        this.map = map;
        map.on('style.load', this.onMapEvent);
        map.on('idle', this.onMapEvent);
      }
      if (!map.isStyleLoaded()) return;

      const dataSignature = JSON.stringify(data);
      const styleSignature = JSON.stringify([options.arrows, options.color, options.width, options.opacity, options.arrowSize]);
      let source = map.getSource(this.sourceId);
      if (!source) {
        map.addSource(this.sourceId, { type: 'geojson', data });
        this.dataSignature = dataSignature;
      } else if (dataSignature !== this.dataSignature) {
        source.setData(data);
        this.dataSignature = dataSignature;
      }

      if (styleSignature !== this.styleSignature) {
        this.removeLayer(map, this.arrowId);
        this.removeLayer(map, this.lineId);
      }
      if ((!options.arrows || this.imageColor !== options.color) && map.hasImage(this.imageId)) {
        this.removeLayer(map, this.arrowId);
        map.removeImage(this.imageId);
        this.imageColor = null;
      }
      const beforeId = map.getLayer('marker-pins') ? 'marker-pins' : undefined;
      if (!map.getLayer(this.lineId)) {
        map.addLayer({
          id: this.lineId,
          type: 'line',
          source: this.sourceId,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': options.color, 'line-width': options.width, 'line-opacity': options.opacity },
        }, beforeId);
      }
      if (options.arrows) {
        if (!map.hasImage(this.imageId)) {
          map.addImage(this.imageId, createArrowImage(options.color), { pixelRatio: 2 });
          this.imageColor = options.color;
        }
        if (!map.getLayer(this.arrowId)) {
          map.addLayer({
            id: this.arrowId,
            type: 'symbol',
            source: this.sourceId,
            layout: {
              'symbol-placement': 'line-center',
              'icon-image': this.imageId,
              'icon-size': options.arrowSize,
              'icon-keep-upright': false,
              'icon-rotation-alignment': 'map',
              'icon-pitch-alignment': 'map',
              'icon-allow-overlap': true,
              'icon-ignore-placement': true,
            },
            paint: { 'icon-opacity': options.opacity },
          }, beforeId);
        }
      }
      this.styleSignature = styleSignature;
    } catch (error) {
      // An incompatible style/view must fail closed until the view is reopened.
      // Otherwise every idle event could retry a failing draw indefinitely.
      this.suspended = true;
      this.releaseMap();
      this.report(error);
    } finally {
      this.updating = false;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseMap();
  }

  private removeLayer(map: MapLike, id: string): void {
    if (map.getLayer(id)) map.removeLayer(id);
  }

  private report(error: unknown): void {
    try { this.onError(error); } catch { /* Reporting must never break official Maps. */ }
  }

  private releaseMap(): void {
    const map = this.map;
    this.map = null;
    this.dataSignature = null;
    this.styleSignature = null;
    this.imageColor = null;
    if (!map) return;
    const cleanup = [
      () => map.off('style.load', this.onMapEvent),
      () => map.off('idle', this.onMapEvent),
      () => this.removeLayer(map, this.arrowId),
      () => this.removeLayer(map, this.lineId),
      () => { if (map.getSource(this.sourceId)) map.removeSource(this.sourceId); },
      () => { if (map.hasImage(this.imageId)) map.removeImage(this.imageId); },
    ];
    for (const operation of cleanup) {
      try { operation(); } catch (error) { this.report(error); }
    }
  }
}
