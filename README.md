# Maps Directions

Add ordered lines and direction arrows to the **Map** layout supplied by the
official [Maps plugin](https://github.com/obsidianmd/obsidian-maps) for Obsidian Bases.
Choose direct connections or experimental paths along roads already loaded by Maps.

This is a companion plugin. Official Maps continues to render every marker,
icon, marker color, popup and map background. Its existing **Display**, **Markers**
and **Background** settings remain available. This plugin appends **Directions**,
**Routing** and **Connection style** groups to the same Map layout. It does not
create a second map layout or bundle a map engine.

## Requirements and installation

- Obsidian 1.13.1 or newer with **Bases** enabled.
- The official **Maps** community plugin installed and enabled.
- Initial integration target: Maps **0.2.2**. The integration uses undocumented
  internals, so compatibility with future Maps/Obsidian updates needs checking.

Download the installation ZIP from [GitHub Releases](https://github.com/theambinder/obsidian-maps-directions/releases),
extract the `maps-directions` folder into your vault's `.obsidian/plugins/`,
then enable **Maps Directions** in **Settings → Community plugins**.
Version 0.2.0 is a testing prerelease, not an Obsidian directory submission.

To build from source instead:

```sh
npm ci --ignore-scripts
npm test
npm run package
```

The installation ZIP is `dist/maps-directions-0.2.0.zip`. You can also copy
`dist/main.js` and `dist/manifest.json` into `.obsidian/plugins/maps-directions/`.

## Use with an existing base

1. Open an existing **Map** view. Keep its current coordinates, marker icons,
   marker colors and background settings.
2. Open that view's settings and expand **Directions**.
3. Turn on **Connect markers** and choose **Sequence property** (default: `Sequence`).
4. Optionally choose **Separate routes by**, for example `Route`, to draw independent chains.
5. In **Routing**, choose **Straight line** or **Follow roads (local)**.
6. Use **Connection style** to set line color, width, opacity and arrow size.

Connections are disabled by default for existing views. **Straight line** remains
the default route mode, including for bases created by version 0.1.0. Settings are
stored per view in the `.base` file, with `directions`-prefixed keys so they do not
replace Maps settings. Reopen an already-open base if a newly enabled integration
is not visible. **Maps Directions: Check Maps integration** reports its status.

Example note properties:

```yaml
coordinates: [35.681236, 139.767125]
Sequence: 1
Route: Japan
```

The coordinate property can have any name or formula supported by Maps; select
it through Maps' original **Marker coordinates** setting. Directions uses the
coordinates of markers already accepted by Maps rather than its own coordinate parser.
The `Sequence` and `Route` fields may also be selected from Bases formula properties.

For a ready-made example, run **Maps Directions: Open directions demo**. It creates
four example stops in `Bases/Maps Directions Demo` and opens a base with the
original **Map** layout plus a **Stops** table. Existing demo files are never overwritten.

## Follow roads locally

**Follow roads (local)** is an experimental, approximate route mode. It reads
road geometry from supported OpenMapTiles `transportation` vector sources already
loaded by the official Maps view, builds a temporary road network and searches
for a short path between each adjacent pair of markers. It keeps the order set by
**Sequence** and processes independent route groups separately.

The standard OpenFreeMap backgrounds are the intended starting point. Custom
raster backgrounds contain pictures rather than road geometry, and other vector
schemas may not expose a compatible road source. An unsupported source falls back
to direct dashed connections.

For a first test, use nearby stops within a small city area and zoom in until the
streets and paths are detailed (zoom level 14 or closer). Wait for Maps to finish loading. A wide view of a
country does not contain every small street: available road detail depends on the
map's zoom level and loaded tiles. A route may be unavailable when its connecting
roads or necessary detour lie outside the loaded area.

Run **Maps Directions: Open local roads demo** for three public example stops
around Tokyo Station, with a detailed map and local routing already selected.
It creates `Bases/Maps Directions Local Demo` without overwriting existing files.
**Maps Directions: Check local routing** reports how many connections found a
road path and explains when more map detail is needed.

- Road paths use the available local network. They are not guaranteed to be the
  shortest path in the complete real-world road network.
- The route geometry is approximate and walking-oriented. It does not provide
  complete driving restrictions, turn-by-turn navigation, traffic or live closures.
- Source tiles are designed for drawing maps. Clipped or simplified roads,
  bridges, tunnels and missing connections can prevent a route from being found.
- A pair without a usable road path is shown as a **straight dashed line**.
  Other pairs can still follow roads.
- Original markers keep their coordinates and appearance. Road routing does
  not move them to a nearby street. Short dashed access lines connect pins to
  their road path when they are up to 100 m from the nearest usable road.

Graph construction and path search run in a bundled background worker. Input
and search limits keep the experimental mode bounded; at most 200 connections
are searched per update, with the rest shown as dashed fallback connections.

Road data and the temporary network stay in memory for the active view. This
release does not download offline areas or persist a road database. Maps loads
its background as usual; there is no new routing service, API key or additional
tile request from Directions. The availability of the Maps background without
internet depends on its own loaded data and cache. Local calculation alone does
not turn Maps into a complete offline map.

## Ordering and filters

- Ordering is numeric: `1 → 2 → 10`; zero, negative and fractional values work.
  Property names are case-sensitive. Use the Number property type where possible.
- A marker without a finite numeric sequence remains an ordinary Maps marker
  but is not connected. No markers are recolored or replaced by Directions.
- Each route is independent. Without a route property, all sequenced markers
  form one chain. Blank route values form one additional common group.
- Equal sequence values are resolved by note path. Use unique numbers within
  a route when you need an unambiguous order.
- Only markers in the current filtered/limited view participate. Hiding a stop
  connects the remaining visible stops; gaps in numbering are allowed.
- Chains are open. The last point is not connected back to the first.
- Direct connections use the short direction when crossing the 180th meridian.

## Compatibility and updates

The addon wraps the installed Maps registration at runtime and adds its own
MapLibre source, layers and arrow image. Maps code and assets are not copied or
modified. Maps features and fixes come from your installed official plugin.

The integration boundary is isolated in `src/adapter.ts`. It checks capabilities,
reattaches when Maps reloads, restores its own wrappers on unload, and suspends
directions when it detects an incompatible object shape. The original Map view
remains usable when the addon cannot attach. Original Maps errors retain their
normal behavior; the addon does not hide them.

An undocumented API can change. A Maps update can require a new adapter release,
even though there is no map-rendering copy to synchronize. New versions are not
automatically considered fully tested just because the capability checks pass.
Mobile is intended to be supported by the same JavaScript code but has not yet
been visually tested.

## Data and network

Directions processes the current map's marker and road data locally. It has no
telemetry, API keys, server, routing requests or additional tile requests. The
official Maps plugin continues to make the background requests configured in Maps.
No marker coordinates or note contents are sent to an additional routing provider.

## Development

- `src/contracts.ts` — the narrow runtime boundary.
- `src/adapter.ts` — Maps/Bases capability checks, registration and lifecycle hooks.
- `src/geometry.ts` — numeric ordering, route grouping and direct line geometry.
- `src/road-graph.ts` — local road network and path search.
- `src/directions-overlay.ts` — owned MapLibre layers and cleanup.
- `src/settings.ts` — the additional view setting groups.
- `src/demo.ts` — generated example data; no personal vault data is included.
- `tests/` — model, routing, overlay ownership and adapter lifecycle checks.

GitHub Actions tests and builds each change. A push to `main` with a new manifest
version creates a prerelease after successful checks; an existing release is not
overwritten. Bump `manifest.json`, `package.json`, `package-lock.json` and
`versions.json` together when preparing a new release.

MIT licensed. This independent addon is not an official Obsidian product.
