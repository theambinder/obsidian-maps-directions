# Maps Directions

Add ordered lines and direction arrows to the **Map** layout supplied by the
official [Maps plugin](https://github.com/obsidianmd/obsidian-maps) for Obsidian Bases.

This is a companion plugin. Official Maps continues to render every marker,
icon, marker color, popup and map background. Its existing **Display**, **Markers**
and **Background** settings remain available. This plugin appends **Directions**
and **Connection style** groups to the same Map layout; it does not create a
second map layout or bundle a map engine.

## Requirements and installation

- Obsidian 1.13.1 or newer with **Bases** enabled.
- The official **Maps** community plugin installed and enabled.
- Initial integration target: Maps **0.2.2**. The integration uses undocumented
  internals, so compatibility with future Maps/Obsidian updates needs checking.

Download the installation ZIP from [GitHub Releases](https://github.com/theambinder/obsidian-maps-directions/releases),
extract the `maps-directions` folder into your vault's `.obsidian/plugins/`,
then enable **Maps Directions** in **Settings → Community plugins**.
The first release is a prerelease for local testing, not an Obsidian directory submission.

To build from source instead:

```sh
npm ci --ignore-scripts
npm test
npm run package
```

The installation ZIP is `dist/maps-directions-0.1.0.zip`. You can also copy
`dist/main.js` and `dist/manifest.json` into `.obsidian/plugins/maps-directions/`.

## Use with an existing base

1. Open an existing **Map** view. Keep its current coordinates, marker icons,
   marker colors and background settings.
2. Open that view's settings and expand **Directions**.
3. Turn on **Connect markers** and choose **Sequence property** (default: `Sequence`).
4. Optionally choose **Separate routes by**, for example `Route`, to draw independent chains.
5. Use **Connection style** to set line color, width, opacity and arrow size.

Connections are disabled by default for existing views. Settings are stored per
view in the `.base` file, with `directions`-prefixed keys so they do not replace
Maps settings. Reopen an already-open base if a newly enabled integration is not
visible. **Maps Directions: Check Maps integration** reports its status.

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
- Each pair is connected by a direct line with an optional central arrow.
  This does not calculate a road, walking or transit route.
- Crossing the 180th meridian uses the short direction rather than circling the world.

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

Directions processes the current map's marker data locally. It has no telemetry,
API keys, server, routing requests or additional tile requests. The official Maps
plugin continues to make the background requests configured in Maps.

## Development

- `src/contracts.ts` — the narrow runtime boundary.
- `src/adapter.ts` — Maps/Bases capability checks, registration and lifecycle hooks.
- `src/geometry.ts` — numeric ordering, route grouping and line geometry.
- `src/directions-overlay.ts` — owned MapLibre layers and cleanup.
- `src/settings.ts` — the two additional view setting groups.
- `src/demo.ts` — generated example data; no personal vault data is included.
- `tests/` — pure model, overlay ownership and adapter lifecycle checks.

GitHub Actions tests and builds each change. A push to `main` with a new manifest
version creates a prerelease after successful checks; an existing release is not
overwritten. Bump `manifest.json`, `package.json`, `package-lock.json` and
`versions.json` together when preparing a new release.

MIT licensed. This independent addon is not an official Obsidian product.
