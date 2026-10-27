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
Version 0.6.2 is a testing prerelease, not an Obsidian directory submission.

To build from source instead:

```sh
npm ci --ignore-scripts
npm test
npm run package
```

The installation ZIP is `dist/maps-directions-0.6.2.zip`. You can also copy
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
   and **Pause/Resume** controls show the saved queue state; the visible map
   stays in place. **Road routes: N/eligible** counts found paths, while preparation
   progress separately shows processed eligible connections and the percentage
   remaining. Distance-excluded connections are counted separately.
   The **Routes** legend identifies each group and its line color.
   The global **Maximum road-routing distance (km)** defaults to 30 km; longer
   connections stay straight and do not load roads for calculation.
   **Maximum pin-to-road access (m)** defaults to 250 m. Access from a pin to its
   chosen road is shown separately as an unverified dashed connector.

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

In **Follow roads (local)** mode, **Road routes: N/eligible** counts found paths
between adjacent stops, rather than route groups. One Day 1 group with five stops
has four connections. Short access lines between pins and their road paths do
not add to that count.

Preparation progress is separate: it shows processed **eligible** connections,
the remaining eligible count and the percentage remaining. Connections excluded
by the distance preference are displayed as **Skipped by distance** and are not
included in either the numerator or denominator of road-processing progress.

The eligible total is all connections minus distance-excluded connections.
Processed eligible connections are **Ready**, **No walking path** and **Data
unavailable**; queued, preparing and paused connections remain unfinished. When
all eligible connections have been processed, progress is 100% even if some other
connections intentionally remain straight. If every connection is excluded, there
is nothing to calculate: progress is 100% with zero remaining. **100% processed
does not mean every eligible connection found a road path.** Result counts distinguish:

- **Queued** — this connection has not been processed yet.
- **Preparing** — its road data is being loaded or searched.
- **Ready** — a road path was found and saved.
- **Straight (distance limit)** — this connection is longer than the configured
  endpoint-distance threshold, so it is intentionally drawn straight without
  road preparation. It is counted separately as skipped by distance and excluded
  from road-processing progress, rather than counted as a found or failed search.
- **No walking path** — a completed local attempt did not find a path with the
  available detailed network.
- **Data unavailable** — the available road detail is insufficient, a source or
  network request failed, or a long connection needs regional routing data.
- **Paused** — work is stopped by the user or an unexpected failure needs an
  explicit retry. The reason is shown; this is not counted as a completed search.

**Pause** preserves the queue. **Resume** continues pending work with the current
plugin-wide processing settings. It does not silently increase memory or time
budgets. Working-data limits instead switch automatically to smaller road
sections within the selected mode. Existing known resource-limit pauses from
older versions are upgraded to that strategy; user pauses and unrecognized
failures stay paused. Other queued connections can still be processed.
Expand the on-map explanation for detailed state and resource scope.

## Saved preparation queue

With **Automatically prepare roads** enabled, saved paths draw immediately.
Missing connections enter a durable per-connection queue after the visible view
has stayed stable briefly. Work runs in the background without moving the user's
map. Multiple views share one preparation slot, so only one temporary preparation
map runs at a time.

There is no fixed limit on the number of connections or map areas in the whole
trip, and no two-minute cut-off for the whole itinerary. The queue processes one
connection at a time in small chunks, saves outcomes and progresses to the next
connection. When a whole-connection search reaches its working-data or worker
budget, it automatically tries smaller overlapping sections. It saves verified
section paths and continues without requiring **Resume** for that budget limit.
Remaining queued connections are not discarded when a chunk ends. Shorter queued
connections get priority. Because this local walking graph is undirected, an
existing reverse path can be reused from the same source when its pin access
meets the current setting; this avoids calculating an identical return walk.

The queue, progress, per-connection reasons and completed route geometry survive
closing the map and restarting Obsidian. A user-paused task stays paused until
**Resume**. Temporary road networks are not saved. An ordinary interrupted search
rebuilds its small area plan; a section search preserves its plan and verified
path prefixes and continues from the saved frontier after reopening. Completed
connections keep their saved paths and outcomes.

Changing endpoints creates a new connection. The source configuration is included
in a hashed task identity, so a different road source can be processed separately.
Color edits, panning and zooming do not invalidate saved geometry. Explicit retry
can request another attempt for a completed unresolved connection.

**Directions → Automatically prepare roads** remains a per-view preference.
Processing mode and pauses are global addon settings, described below. Internet
is needed for road data absent from Maps cache.

## Global processing settings

Open **Settings → Maps Directions** to choose the maximum routing distance,
pin-to-road access distance, processing mode and pause between chunks. **Eco**
is the default. These preferences apply across map views;
they are not added to each map's Directions configuration.

**Maximum road-routing distance (km)** defaults to **30**. The distance is the
straight-line, great-circle separation between each pair of consecutive stops,
not the length of a road path that has yet to be calculated. Connections strictly
longer than the threshold use a straight line and enter **Straight (distance
limit)**. No road-loading or path-search job is started for them, including on an
explicit retry. Exactly-at-threshold connections remain eligible. Set **0** to
disable the distance threshold. Changing this setting recalculates the eligible
progress total; distance-excluded connections never inflate the completion count.

The limit also applies to already saved paths: above-threshold connections are
shown straight while the preference is active. Previously calculated geometry is
kept, so raising or disabling the threshold can restore that path without
calculating it again. Connections that have not previously been calculated enter
the normal queue when they become eligible. Changing processing mode or pause
preserves the distance and pin-access settings.

This is an explicit per-connection preference, not a hidden cap on the number of
connections in the trip.

**Maximum pin-to-road access (m)** defaults to **250** and accepts **0–1000 m**.
It exposes the previous fixed 100 m allowance for matching original pins to
nearby allowed roads. Set **0** to require pins to be on the road geometry. The
pin retains its original coordinates; any access to the chosen road is displayed
as a dashed connector and is **not a verified walking path**. A larger value can
select the wrong road or side of a barrier and require an unverified walk. This
setting applies only at original pins. Internal section joins still require
matching road anchors and cannot jump between nearby disconnected roads.
Changing the allowance queues unresolved connections again, including completed
**No path** and **Data unavailable** outcomes. Active saved section prefixes
restart with the new allowance. With **Automatically prepare roads** enabled,
those searches retry without manual **Retry** or **Resume**. Completed saved
routes, explicit user pauses and pauses for unexpected failures are kept.

| Mode | Areas per chunk | Default pause | Hidden viewport | Tile cache | Working road lines / coordinates | Worker timeout |
| --- | ---: | ---: | --- | ---: | --- | ---: |
| **Eco** | 2 | 1 second | 768 × 512 | 8 | 6,000 / 50,000 | 8 seconds |
| **Balanced** | 4 | 0.25 seconds | 1024 × 768 | 16 | 12,000 / 100,000 | 12 seconds |
| **Maximum** | 8 | No pause | 1280 × 768 | 32 | 24,000 / 200,000 | 20 seconds |

All modes use one active preparation job. The custom pause accepts 0–60 seconds;
changing the mode restores that mode's default pause. Longer pauses reduce
average activity and make preparation slower. Larger working networks can handle
more complex areas but consume more memory. These are limits on one working part,
not limits on the trip length, CPU percentages or a guaranteed number of MiB.

Processing can briefly occupy a CPU core even in Eco mode. Larger modes can
increase network activity, CPU usage, GPU memory, heat and battery consumption.
They do not guarantee that a path exists or that drawing-oriented source data
contains all routing connections.

## Follow roads locally

**Follow roads (local)** is an experimental, approximate walking route mode. It
reads geometry from supported OpenMapTiles `transportation` vector sources,
builds a temporary road network and searches for a short path between each
adjacent pair of markers. It keeps the order set by **Sequence** and processes
independent route groups separately.

The standard OpenFreeMap backgrounds are the intended starting point. Custom
raster backgrounds contain pictures rather than road geometry, and other vector
schemas may not expose a compatible road source. A connection without saved path
geometry is displayed as a direct dashed line; its queue state explains whether
it is pending, paused or already attempted.

A drawn road on a zoomed-out map does not necessarily expose the detailed,
connected network required for searching. Preparation uses one temporary hidden
MapLibre map supplied by the installed Maps runtime and the current background's
transport vector sources. It copies no marker sources, note data, sprites or
icons. The visible map's camera, style and markers remain unchanged.

Each eligible connection receives an adaptive overview, corridor and endpoint
plan. Connections over the configured distance threshold are intentionally drawn
straight before planning or loading road areas. When the threshold is raised or
disabled, a long connection's regional overview may still be insufficient for a complete walking path;
that outcome is shown as **Data unavailable**, with an explanation, rather than
proof that no route exists. A dense area is subdivided into smaller overlapping
views up to street detail level 16. If that is insufficient, or an accumulated
network exceeds the selected working budget, calculation automatically switches
to overlapping local sections.

The initial search retains a bounded network across its chunks. The section
fallback builds a separate graph for each small window, saves verified path
prefixes, then releases the local road network and worker graph before the next
window. It considers several real road crossings at each seam. Internal anchors
must match the same road level and direction, with at most 5 cm projection error;
the configurable pin-access allowance is not used to join sections. This prevents a
straight shortcut between disconnected roads or between bridge and ground levels.

Ground roads at the same level also connect at geometric intersections when the
tile lines have no explicit vertex at the crossing. Bridge, tunnel and different
level crossings remain separated unless a valid road endpoint transition exists.
Clipping a window cannot manufacture such a transition from an artificial endpoint.

The fallback makes up to three attempts with progressively wider corridors and
shorter forward steps. It does not retry the same whole-connection network
indefinitely. If those attempts cannot assemble a connected path, the result is
**Data unavailable**, with an explanation, rather than a false claim that no
walking path exists. The finite corridor and candidate search cannot guarantee
every route or the globally shortest path, particularly around water, mountains,
large detours or incomplete map topology.

Smaller working networks bound retained road data; they do not guarantee lower
instantaneous CPU use. Repeated tile loading, graph construction and saved-prefix
writes can increase total calculation time, network activity, shared HTTP cache
size and addon data size. The selected processing mode and pauses still apply.

Found paths are saved automatically. Durable trip results do not depend on the
small opportunistic path cache and are not silently evicted after 500 paths or
100,000 stored vertices. Saved route geometry and queue metadata grow on disk with
the processed connections. This is not an on-disk road tile database, and the
background's own availability offline is still governed by Maps and its cache.

If the nearest road belongs to an isolated fragment, the search can try another
allowed road within **Maximum pin-to-road access (m)**, which defaults to 250 m.
Markers keep their original coordinates, and unverified dashed access lines
connect them to the chosen road path. Increasing this allowance can choose the
wrong road or side and does not verify that the access walk is possible. Missing road geometry,
bridges, tunnels and required detours can still prevent a route from being found.

Walking restrictions are a choice in this addon's routing algorithm, not a
MapLibre restriction. This release does not implement correct driving directions,
complete one-way and turn restrictions, ferries, public transport timetables,
traffic or live closures. Road tiles are designed for drawing maps, so complete
routing for every connection is not guaranteed.

Run **Maps Directions: Open local roads demo** for public example stops around
Tokyo Station. It creates `Bases/Maps Directions Local Demo` without overwriting
existing files. **Maps Directions: Check local routing** reports current status.

## Resource measurements

The on-map monitor reports preparation progress and available CPU/private-memory
measurements, plus separately scoped storage information. CPU and memory readings
refer to the **Obsidian window process**, including its other plugins and contents. They are not isolated addon usage, and
exclude the GPU process and other application processes.

CPU uses cumulative process time over the sample interval. **100% means one CPU
core equivalent**; multiple threads can produce values over 100%. Memory values
are **MiB** (1,048,576 bytes) of private process memory, not a guarantee about total
physical RAM or the addon's own allocations. Unsupported readings are shown as
unavailable instead of zero. Sampling is local and is not sent to a server.

A run can report elapsed time, sample count, current/average/peak CPU, baseline
and peak private memory, memory change, and processed/result counts. Measurements
include unrelated activity in the same window, so comparing an idle baseline and
a processing run is more informative than treating every change as plugin-only
cost. Brief final samples are excluded from instantaneous peak calculation to
avoid misleading timing-resolution spikes.

## Disk usage

The storage monitor measures the logical byte size of this addon's
`.obsidian/plugins/maps-directions/data.json` file using the vault adapter's file
statistics. It shows the current saved-data size and a signed change since the
first successful measurement in the current plugin session. Restarting the addon
starts a new comparison baseline. A negative change means the file became smaller;
it is not a download counter. Unsupported file statistics are shown as unavailable.

That file contains preferences, queue metadata, area plans, progress, retry
metadata, saved section frontiers and route coordinates. Section calculations
can temporarily retain several verified path prefixes; those checkpoints are
replaced by the final result when the connection finishes. More stored connections or more detailed
saved paths can make it grow. Distance alone does not determine its size: the
number of areas, coordinate vertices and retained results matters. Working road
lines and the search graph are temporary RAM data, not an addon-managed tile
archive on disk.

Map preparation can also fetch tile and metadata responses through Maps' existing
providers. Chromium's shared HTTP cache may retain responses according to their
cache policy. This is separate from the addon's `data.json` and the temporary
in-memory tile cache.

On supported desktop installations, a separate **Shared HTTP cache** counter
uses Electron's current-session cache-size API. It shows the reported cache bytes
and a signed change since the first successful measurement in the current plugin
session, refreshed periodically. It includes all HTTP resources in that shared
Obsidian browser session, including requests unrelated to Maps or this addon.
It is not a Maps-only counter, and a change cannot be attributed to route
preparation alone. When the API is unavailable, the value remains unknown rather
than zero. Reading this counter does not clear shared cached responses.

The saved-data file statistic and Electron's cache-size counter are logical byte
measurements, not guarantees about physically allocated disk blocks. They do not
include cloud sync history, every Obsidian/plugin file or other browser sessions.
The two counters remain separate rather than being presented as the plugin's
complete disk footprint.

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

Local plugin data in `.obsidian/plugins/maps-directions/data.json` stores ordered
endpoint coordinates, completed route geometry, area plans, task states, reasons
and progress, together with global workload settings and legacy cooldown/cache
records. Source identities are hashed; raw provider URLs, note names, note
contents and route group labels are not stored in queue records. Saved queue and
route data grows with the processed connections. Temporary road geometry is not
persisted. Like other vault files, this plugin data may be included by your
configured vault sync or backup tools.

## Development

- `src/contracts.ts` — the narrow runtime boundary.
- `src/adapter.ts` — Maps/Bases capability checks, registration and lifecycle hooks.
- `src/geometry.ts` — numeric ordering, route grouping and direct line geometry.
- `src/road-graph.ts` — local road network and path search.
- `src/route-colors.ts` — contrasting group color allocation and property colors.
- `src/route-legend.ts` — grouped route labels and rendered line colors.
- `src/route-status-control.ts` — local routing progress, preparation and cancellation.
- `src/background-roads.ts` — bounded temporary-map road detail loading and cleanup.
- `src/trip-queue.ts` — durable connection outcomes, progress and adaptive area plans.
- `src/detailed-road-memory.ts` — bounded working road geometry for a connection.
- `src/route-cache.ts` — bounded persistent endpoint-to-path geometry cache.
- `src/directions-overlay.ts` — owned MapLibre layers and cleanup.
- `src/settings.ts` — the additional Directions settings.
- `src/workload-settings.ts` — global Eco/Balanced/Maximum work profiles.
- `src/workload-settings-tab.ts` — global addon processing preferences.
- `src/resource-sampler.ts` — local process-scoped CPU/private-memory measurements.
- `src/demo.ts` — generated example data; no personal vault data is included.
- `tests/` — model, routing, overlay ownership and adapter lifecycle checks.

GitHub Actions tests and builds each change. A push to `main` with a new manifest
version creates a prerelease after successful checks; an existing release is not
overwritten. Bump `manifest.json`, `package.json`, `package-lock.json` and
`versions.json` together when preparing a new release.

MIT licensed. This independent addon is not an official Obsidian product.
