/** The small, undocumented Maps/Bases boundary. Keep all runtime probing in adapter.ts. */
export interface ValueLike {
  toString(): string;
  isTruthy?(): boolean;
}

export interface EntryLike {
  file: { path: string; basename?: string };
  getValue(property: string): ValueLike | null;
}

export interface ViewConfigLike {
  get(key: string): unknown;
  getAsPropertyId(key: string): string | null;
}

export interface MapsMarker {
  entry: EntryLike;
  coordinates: [number, number];
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: Record<string, string | number>;
    geometry: { type: 'LineString'; coordinates: [number, number][] };
  }>;
}

export interface GeoJSONSourceLike {
  setData(data: FeatureCollection): unknown;
}

/** Public MapLibre operations; the MapLibre runtime is supplied by official Maps. */
export interface MapLike {
  getStyle?(): { sources?: Record<string, { type?: string }>; layers?: Array<{ source?: string; 'source-layer'?: string }> };
  getZoom?(): number;
  querySourceFeatures?(sourceId: string, options: { sourceLayer: string }): import('./road-graph').RoadFeature[];
  isStyleLoaded(): boolean;
  getSource(id: string): GeoJSONSourceLike | undefined;
  addSource(id: string, source: { type: 'geojson'; data: FeatureCollection }): unknown;
  removeSource(id: string): unknown;
  getLayer(id: string): unknown;
  addLayer(layer: Record<string, unknown>, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  hasImage(id: string): boolean;
  addImage(id: string, image: { width: number; height: number; data: Uint8Array }, options?: { pixelRatio?: number }): unknown;
  removeImage(id: string): unknown;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  off(event: string, handler: (...args: unknown[]) => void): unknown;
}

export interface MarkerManagerLike {
  markers: MapsMarker[];
  updateMarkers: (...args: unknown[]) => unknown;
}

export interface MapsViewLike {
  type: string;
  config: ViewConfigLike;
  map: MapLike | null;
  markerManager: MarkerManagerLike;
  register(cleanup: () => void): void;
}

export interface OverlayLike {
  update(): void;
  destroy(): void;
  getRoutingStatus?(): string;
}
