# Maps Directions

Add ordered lines and direction arrows to the **Map** layout supplied by the
official [Maps plugin](https://github.com/obsidianmd/obsidian-maps) for Obsidian Bases.
Choose direct connections or experimental walking paths along roads, with automatic
background preparation, contrasting route colors, or colors from a note property.

This is a companion plugin. Official Maps continues to render every marker,
icon, marker color, popup and map background. Its existing **Display**, **Markers**
and **Background** settings remain available. This plugin appends a single **Directions** group to the same Map layout,
including route and line appearance settings. It does not create a second map
layout or bundle a map engine.

## Requirements and installation

- Obsidian 1.13.1 or newer with **Bases** enabled.
- The official **Maps** community plugin installed and enabled.
- Initial integration target: Maps **0.2.2**. The integration uses undocumented
  internals, so compatibility with future Maps/Obsidian updates needs checking.

Download the installation ZIP from [GitHub Releases](https://github.com/theambinder/obsidian-maps-directions/releases),
extract the `maps-directions` folder into your vault's `.obsidian/plugins/`,
then enable **Maps Directions** in **Settings → Community plugins**.
Version 0.5.0 is a testing prerelease, not an Obsidian directory submission.

To build from source instead:

```sh
npm ci --ignore-scripts
npm test
npm run package
```

The installation ZIP is `dist/maps-directions-0.5.0.zip`. You can also copy
`dist/main.js` and `dist/manifest.json` into `.obsidian/plugins/maps-directions/`.

## Use with an existing base

1. Open an existing **Map** view. Keep its current coordinates, marker icons,
   marker colors and background settings.
2. Open that view's settings and expand **Directions**.
3. Turn on **Connect markers** and choose a numeric **Sequence property**, for example `Sequence`.
4. Optionally choose **Separate routes by**, for example `Route`, to draw independent chains.
5. In **Directions → Route mode**, choose **Straight line** or **Follow roads (local)**.
6. Choose **Line color mode**: **Single color**, **Random by route** or **Color property**.
   The matching **Line color** or **Color property** control appears below it.
7. Adjust line width, opacity and arrow size in the same **Directions** group.
8. In local mode, saved paths appear immediately and missing paths prepare in
   the background. **Automatically prepare roads** is on by default. Progress
   and **Cancel** appear while work runs; the visible map stays in place.
   **Road routes: N/total** shows the result, and the **Routes** legend identifies
   each group and its line color.

Connections are disabled by default for existing views. **Straight line** remains
the default route mode, including for bases created by version 0.1.0. Settings are
stored per view in the `.base` file, with `directions`-prefixed keys so they do not
replace Maps settings. Reopen an already-open base if a newly enabled integration
is not visible. **Maps Directions: Check Maps integration** reports its status.

**Sequence property** has no automatic selection. Clearing it removes all
connections, while Maps keeps displaying the markers. It stays unselected after
closing and reopening the map. A missing sequence selection also draws no lines,
even when notes contain a property named `Sequence`. Views with an explicitly
saved selection keep using that selection.

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

## Separate routes by

This setting selects a property that divides markers into independent chains.
For example, select `Route` and give the notes these values:

| Stop | Route | Sequence |
| --- | --- | --- |
| A | Day 1 | 1 |
| B | Day 1 | 2 |
| C | Day 2 | 1 |
| D | Day 2 | 2 |

The map draws **A → B** for Day 1 and **C → D** for Day 2. It does not connect
B to C. Sequence order is evaluated inside each group, so each day can start at 1.
If **Separate routes by** is empty, all sequenced markers form one chain.
The grouping example in the local demo uses the same `Route` property to show
two independent routes; existing Sequence values determine the order within each.
Newly generated local demos include a **Separate routes example** Map view and
a **Route** column in **Stops**. The demo command does not rewrite existing files.

## Route colors

All color controls are inside **Directions**. **Single color** is the default,
so existing views keep their selected line color.

| Line color mode | Behavior | Control shown below it |
| --- | --- | --- |
| **Single color** | Every connection uses the same color. | **Line color**, with the existing color choices. |
| **Random by route** | Route groups receive contrasting colors chosen together from a categorical palette. | No additional color control. |
| **Color property** | Each route takes its color from the selected note or formula property. | **Color property**, a property selector. |

Automatic colors are assigned together, rather than generating an independent
random hue for each group. The allocator favors colors that differ from those
already assigned, making a few simultaneous routes easier to distinguish. Colors
stay stable while the view remains open, including when other groups are filtered
out and back in. The same complete group set receives deterministic colors when
reopened. Opening an initially filtered subset, or introducing new groups, can
produce different assignments; use **Color property** when a route must always
have a specific color.

A blank route value is one group. Without **Separate routes by**, all sequenced
markers belong to one route and receive one automatic color. There is a practical
limit to how many colors can be clearly distinguished at once; a large number of
routes can still require filtering or explicit property colors.

For property colors, select a field such as `RouteColor`. For example:

| Route | RouteColor | Result |
| --- | --- | --- |
| Day 1 | `#2583e8` | Blue lines and arrows for the first day. |
| Day 2 | `#ef8733` | Orange lines and arrows for the second day. |

Put the same value on the stops of each route to make the intent clear. If values
within a route differ, the first valid color in Sequence order is used for the
whole route; equal sequence values use note path order. Missing, empty or invalid
colors fall back to the view's saved **Line color** selection. Clearing the color
property selection also uses that fallback.

Color values can use hex notation, `rgb()`, `hsl()` or CSS color names. Colors are
normalized to opaque RGB; use **Line opacity** to control transparency. Lines,
road paths, dashed fallback/access segments and direction arrows share the route
color. Changing color settings updates their appearance without calculating the
road path again. Original Maps marker colors remain controlled by Maps.

## Map legend and routing progress

When **Separate routes by** is selected, a collapsible **Routes** legend appears
at the bottom-left of the map. It lists each visible route group with the actual
color of its line, in all three color modes. A blank group is labeled
**Ungrouped**. The legend scrolls when there are many groups and disappears when
there are no connections or no grouping property.

In **Follow roads (local)** mode, the top-left **Road routes: N/total** control
counts individual connections between adjacent stops, rather than route groups.
For example, one Day 1 group with five stops has four connections. The count
excludes short dashed access lines between the markers and their road paths.
Expand **Why dashed lines?** for the local routing status and an explanation.

With **Automatically prepare roads** enabled, saved paths are drawn first and
missing connections prepare after the visible view has stayed stable for about
750 ms. No prepare button is needed. The control shows **Preparing roads: x/y
areas** and **Cancel** while work runs, then reports the result. The visible map
does not move, and found paths are saved even when preparation is cancelled.

Automatic attempts are limited to avoid repeatedly downloading roads for the
same unresolved connections. A connection that still has no path waits 24 hours
before another automatic attempt; unavailable data, an incomplete preparation
(time, area or long-distance limits), or a failed attempt waits 15 minutes. These cooldowns survive reopening the view and restarting Obsidian.
Cancelling suppresses the current view's automatic attempt until it is reopened
or its connection input changes. Run **Maps Directions: Retry missing road
routes** to request another attempt without waiting for a cooldown.

Turn **Directions → Automatically prepare roads** off to use manual preparation.
The **Prepare road routes** button is available in that mode when paths are
missing. Internet is needed for areas absent from Maps cache.

## Follow roads locally

**Follow roads (local)** is an experimental, approximate walking route mode. It
reads geometry from supported OpenMapTiles `transportation` vector sources,
builds a temporary road network and searches for a short path between each
adjacent pair of markers. It keeps the order set by **Sequence** and processes
independent route groups separately.

The standard OpenFreeMap backgrounds are the intended starting point. Custom
raster backgrounds contain pictures rather than road geometry, and other vector
schemas may not expose a compatible road source. Connections without a saved
road path fall back to direct dashed lines when the source is unsupported.

A road drawn on a zoomed-out map does not necessarily provide the detailed,
connected geometry needed for route calculation. Automatic preparation loads
street detail through one temporary hidden map, using the MapLibre
runtime already installed with Maps and the current background's transport vector
sources. The addon copies no marker sources, note data, sprites or icons to that
map. The visible map's camera, style and markers remain unchanged. No manual
zooming or panning is required to run preparation.

The hidden map is reused across the selected areas and removed when preparation
finishes or is cancelled. Preparation jobs share one queue, so only one hidden
preparation map runs across the plugin's views at a time. Each active job is
limited to 64 areas, an eight-second load wait per area and a two-minute overall
deadline. Its tile cache is limited
to 32 tiles. At most 200 unresolved connections are considered; nearby urban
connections are prioritized. Legs longer than 30 km receive endpoint detail
rather than an entire intercity tile corridor. The result can therefore be
partial, with an explanation shown in the map control.

The addon also reads detailed roads already loaded by the visible Maps view.
While that view remains open, the bounded temporary road collection accumulates
geometry from neighboring areas and preparation, allowing paths across those
areas. Road data and graph construction remain local after tile loading.

Found paths are saved automatically and stay visible when you zoom out, pan,
change the map style, reopen the view or restart Obsidian. A saved path is reused
when the ordered pair of endpoint coordinates still matches. Moving a stop,
changing **Sequence**, or filtering stops can create a different connection that
needs calculation or preparation. Changing colors or route labels does not
invalidate a path with the same endpoints. Panning, zooming, changing line colors
or reloading a style does not by itself start another preparation pass.

If the nearest road belongs to an isolated fragment, the search can try another
nearby road within 100 m. Markers keep their original coordinates, and short
dashed access lines connect them to the chosen road path. This helps around
parallel streets and disconnected paths, but cannot invent a bridge across water
or recover road geometry absent from the prepared area. Ferry, flight and distant
connections may remain straight dashed lines. A necessary detour outside the
bounded prepared area can also leave a connection unresolved.

Run **Maps Directions: Open local roads demo** for public example stops
around Tokyo Station, with a detailed map and local routing already selected.
It creates `Bases/Maps Directions Local Demo` without overwriting existing files.
**Maps Directions: Check local routing** also reports how many connections found
a road path and explains its current status.

- Road paths use the available local network. They are not guaranteed to be the
  shortest path in the complete real-world road network.
- The route geometry is approximate and walking-oriented. It does not provide
  complete driving restrictions, turn-by-turn navigation, traffic or live closures.
- Source tiles are designed for drawing maps. Clipped or simplified roads,
  bridges, tunnels and missing connections can prevent a route from being found.
- A pair without a usable road path is shown as a **straight dashed line**.
  Other pairs can still follow roads.

Graph construction and path search run in a bundled background worker. Input
and search limits keep the experimental mode bounded; at most 200 connections
are searched per update. Connections without a searched or saved road path
use dashed fallback lines.

The persistent cache stores route geometry only, not a road database or offline
map areas. It is limited to 500 saved paths, 100,000 total coordinate vertices
and 10,000 vertices per path. The oldest created or updated entries are removed
when the limits are reached. Detailed road data and the temporary network remain
in memory for the active view and are not saved to disk.

Directions adds no routing service, API key or bundled map engine. Automatic
preparation, manual preparation and explicit retries can make additional tile and
metadata requests to the current map background's existing vector source
providers through the temporary map. Ordinary use of the visible map also makes
its usual background requests. Without internet, preparation depends on the
background tiles already available in Maps cache. Saved path lines can be reused
locally, but this does not provide a complete offline map or guarantee a route
for every connection.

Preparing new areas uses network bandwidth, background CPU work and a temporary
GPU map context, so it can increase memory use and battery consumption. Cached
paths are shown before that work begins; the shared queue, cooldowns and fixed
limits reduce repeated work. Disable **Automatically prepare roads** when manual
control of these background requests is preferable.

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

Directions processes marker data and searches the road network locally. It has
no telemetry, external routing provider, server or new API key. The official
Maps plugin continues to make its configured background requests.

When automatic preparation is enabled for a local route view, opening it can
make additional tile and metadata requests to the current background's vector
source providers through a temporary hidden map. Manual preparation and retries
can make the same requests. Marker sources, note names and note contents are not
copied to the temporary map or sent to an additional routing provider. As with
normal map use, tile requests identify the geographic areas being loaded to the
background provider.

The bounded local cache in `.obsidian/plugins/maps-directions/data.json` stores
ordered endpoint coordinates, route geometry and path distance, plus cooldown
records containing hashed attempt identifiers and times. Attempt records contain
no raw source URLs or group labels. The cache does not store note names, note
contents, route group names or a road tile database. Like other vault files, this
plugin data may be included by your configured vault sync or backup tools.

## Development

- `src/contracts.ts` — the narrow runtime boundary.
- `src/adapter.ts` — Maps/Bases capability checks, registration and lifecycle hooks.
- `src/geometry.ts` — numeric ordering, route grouping and direct line geometry.
- `src/road-graph.ts` — local road network and path search.
- `src/route-colors.ts` — contrasting group color allocation and property colors.
- `src/route-legend.ts` — grouped route labels and rendered line colors.
- `src/route-status-control.ts` — local routing progress, preparation and cancellation.
- `src/background-roads.ts` — bounded temporary-map road detail loading and cleanup.
- `src/road-preparation-targets.ts` — bounded detail-area planning for unresolved connections.
- `src/detailed-road-memory.ts` — bounded road accumulation for the active view.
- `src/route-cache.ts` — bounded persistent endpoint-to-path geometry cache.
- `src/directions-overlay.ts` — owned MapLibre layers and cleanup.
- `src/settings.ts` — the additional Directions settings.
- `src/demo.ts` — generated example data; no personal vault data is included.
- `tests/` — model, routing, overlay ownership and adapter lifecycle checks.

GitHub Actions tests and builds each change. A push to `main` with a new manifest
version creates a prerelease after successful checks; an existing release is not
overwritten. Bump `manifest.json`, `package.json`, `package-lock.json` and
`versions.json` together when preparing a new release.

MIT licensed. This independent addon is not an official Obsidian product.
