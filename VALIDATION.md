# Validation — Maps Directions 0.6.4

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 28 October 2026.

- All 402 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- The closed map panel exposes only processed/remaining progress. Found routes,
  skipped long connections, current status, actions and resource readings belong
  to its expandable body. Semantic regressions verify collapsed containment,
  expansion controls and unchanged eligible-only processing counts.
- New and invalid pin-access preferences default to 300 m. Explicit saved values,
  custom distances, processing modes and pauses retain their existing behavior.
- Shared-road detection tolerates millimetre coordinate rounding and short seam
  vertices while retaining the 10 cm position limit and a bounded parallel check.
  Rounded paths from different groups occupy separate visual lanes, including
  opposite travel and three groups with different vertex subdivisions.
- Near-identical endpoint cuts avoid centered slivers between shared pieces.
  Crossings, neighboring streets, repeated passes, world seams and spatial-index
  performance regressions pass. Frozen-input replay preserves cached geometry.
- Native verification on the reported visible road shows both route colors
  separately with their matching arrows. The panel expands to route results and
  collapses back to processing progress. Original Maps and the working Base keep
  their data and configuration.
- Personal trip captures, map coordinates, vault notes and diagnostic artifacts
  are excluded from source and release files.

---

# Validation — Maps Directions 0.6.3

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 28 October 2026.

- All 397 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- A synthetic walking detour with substantial sideways and backward travel is
  found through a bounded overview guide and verified by real detailed graphs.
  A coarse guide without connected detailed roads never becomes a final route.
- Guide fetching retains Eco's feature/coordinate limits. Detailed passes keep
  fixed street zoom levels, local tangent gates, strict anchors and per-window
  graph release. Guide-only projection cannot relax final pin access or seams.
- Guides, selected pass, cursor and verified frontier are validated and deep-copied
  through persistence. Reload resumes the detailed prefix without fetching a new
  guide; terminal results clear working checkpoints.
- Only the exact known old section failure upgrades automatically, once, while
  automatic preparation is enabled. New terminal failures, saved paths, distance
  exclusions and explicit user pauses retain their behavior.
- Hidden views, user pause, source-generation changes, replaced endpoints and
  changed distance policy reject late results. A hidden in-progress guide task
  is requeued instead of being incorrectly recorded as unavailable.
- Shared road runs get parallel screen-pixel lanes for two or more routes,
  opposite directions and repeated traversals. Tests cover curves, partial
  overlaps with different subdivisions, nearby streets, crossings and world seams.
- Sparse hierarchical indexing avoids quadratic work for long vertical/horizontal
  routes even with unrelated distant geometry. Unchanged geometry reuses its
  layout. Saved route coordinates, lengths and official Maps markers are intact.
- Native Maps displays shifted lines with matching arrows and the compact panel.
  A previously unresolved detour completes automatically in Eco; unsupported
  walking crossings finish honestly without a Resume or repeated-failure loop.
- Progress excludes distance-skipped connections. Loader counts, reasons, CPU/RAM
  and own saved-data size are inside closed Details; unchanged visible progress
  is not rewritten on every resource tick. Shared HTTP-cache polling is removed.
- Personal trip geometry, native resource samples, notes, cache files and
  machine-specific paths are excluded from source and release artifacts.

---

# Validation — Maps Directions 0.6.2

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 28 October 2026.

- All 375 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- Known legacy working-data pauses automatically enter section routing when an
  automatic Map view opens. Explicit user pauses, unknown errors and distance
  exclusions retain their previous semantics; the default remains Eco and 30 km.
- Production clipping, real road graphs and strict worker anchors verify connected
  multi-window paths, a real detour requiring the wider corridor, alternative
  frontier paths when the nearest street dead-ends, and date-line continuation.
- Exact geometric intersections of same-grade road interiors become junctions.
  Parallel gaps and different bridge/tunnel levels remain disconnected; bounded
  spatial pair checks report truncation rather than exhausting unbounded work.
- Global pin-to-road access defaults to 250 m and is adjustable from 0 to 1000 m.
  Its dashed connector stays separate from verified road geometry. Access changes
  automatically retry unresolved searches while preserving saved paths and pauses.
- Internal seams require matching road level and bearing with at most 5 cm error;
  they cannot use ordinary 100 m marker snapping. Stable millimetre-scale graph
  coordinates prevent artificial seam shifts between overlapping snapshots.
- Clip-created endpoints retain provenance and cannot invent bridge/ground
  transitions. Original bridge entrances and same-grade tile stitching still
  work. Metadata survives collection, repeated clipping and bounded road memory.
- A window is clipped before applying working feature/coordinate budgets. Each
  temporary map and worker graph is released between sections; CPU percentages
  and total application memory remain measured, not guaranteed by a mode name.
- Short-first scheduling remains scoped to the selected view and does not revive
  paused tasks. Reverse walking-path reuse requires the same source and current
  access allowance; it never reuses another source or mutates the original path.
- Section checkpoints deep-clone and validate frontier anchors, levels, bearings,
  cursor bounds and path joins. Reload and in-memory interruption preserve saved
  prefixes; late results after pause, source or distance changes cannot commit.
- Cancellation immediately after a checkpoint requeues the live connection without
  requiring a reload. Completed paths for other connections remain unchanged.
- Unavailable, timed-out, oversized or unsolved truncated section data receives
  finite retries and corridor alternatives. A complete verified path can still be
  used from a partial graph or partial tile wait; missing data alone never creates a road connection. Exhausted partial searches are Data unavailable,
  never proof of no real path and never an endless automatic Resume loop.
- The native working map starts known budget-stopped connections without pressing
  Resume, shows saved section progress and retains its eligible-only trip counters.
- Personal trip geometry, native resource samples, vault notes and cache files are
  excluded from the repository and release. Algorithm tuning remains in 0.6.x.

---

# Validation — Maps Directions 0.6.1

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 28 October 2026.

- All 307 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- The global road-routing distance defaults to 30 km and measures straight-line
  great-circle separation between consecutive stops. Strictly longer connections
  use intentional straight lines without allocating a preparation map or worker.
  Zero disables the threshold; exactly-at-threshold connections remain eligible.
- Production-map progress counts only eligible connections. Distance-skipped
  connections have their own visible count and are excluded from processed tasks,
  the denominator and area totals. All eligible work finished shows 100%; all-direct
  views have zero remaining. Paused work remains unfinished and resumable.
- Progress remains below 100% while any eligible task is unfinished, including
  large queues where ordinary rounding would hide the last task. Found/eligible
  counters use matching deduplicated queue tasks for geometry shared by groups.
- Model, processor and production-overlay regressions cover mixed pending/ready/
  direct work, persisted exclusions, changing the threshold during a worker search,
  restoration of previous outcomes, preserved geometry and no unnecessary reload.
- Native Settings and the working map show the default threshold, eligible progress,
  skipped count, own saved-file size and a separate shared HTTP-cache reading.
- Increasing or disabling the threshold restores retained completed road geometry;
  lowering it hides that geometry while keeping it available for later reuse.
  Existing paused and failed outcomes are preserved rather than retried implicitly.
- Own storage measurements stat only the addon data.json file after successful
  saves. The signed session delta stays in memory and is never persisted into the
  file being measured. Missing/unsupported readings remain distinct from zero.
- The optional Electron shared-session HTTP-cache counter is sampled every 30
  seconds, deduplicates overlapping reads and rejects late updates after unload.
  Its scope explicitly includes Maps and unrelated resources/plugins. It is not
  attributed to the addon alone or presented as allocated disk blocks or all
  application storage. No cache scanning, deletion or clearing is performed.
- Native reload restored durable outcomes without repeating completed work or
  leaving a temporary map. Global Eco preferences, existing map settings and
  original Maps resources remain intact.
- No personal vault files, trip coordinates, benchmark data or local measurements
  are included in the published sources or release package. Algorithm tuning stays
  within the 0.6.x release series.

---

# Validation — Maps Directions 0.6.0

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 28 October 2026.

- All 258 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- The production Map view uses the durable per-connection queue. Cached paths draw
  first, new work runs in Eco chunks, and the queue does not stop at a whole-trip
  connection, area or time quota. Temporary road geometry is released per connection.
- The actual native UI shows processed connections, percentage remaining, found
  road routes, live window CPU/private-memory readings, Pause and Resume.
- A measured working-map Eco run completed available work and explicitly paused
  connections exceeding the Eco working-data budget. Paused tasks remain unfinished;
  they are not labelled as no walking path or silently discarded.
- Reloading restored completed results, durable route geometry and paused tasks,
  without repeating completed work or allocating another preparation map.
- The native plugin settings tab exposes Processing mode and Pause between chunks;
  Eco and its one-second pause are the defaults. Settings are global to the addon.
- Regression coverage includes more than 200 trip connections, more than 500 durable
  paths, deep route persistence, zero/coarse map zooms, dense-area subdivision,
  partial loading deadlines, per-task outcomes, interrupted connections, pause/resume,
  global workload changes, source changes and shared-queue cleanup/fairness.
- Maximum/Eco geometry budgets and configured worker timeouts are verified. Resource
  sampling handles unsupported APIs, overlapping reads and bounded history.
- CPU percentages use one logical core as 100%; memory uses MiB. Native readings
  refer to the current Obsidian window process, including other plugins. GPU and
  other application processes are excluded; isolated addon use is not claimed.
- Individual working graph/time budgets remain explicit. Coarse regional attempts
  and missing source data are kept separate from a failed detailed walking search.
- Personal benchmark samples, hardware information, vault notes and cached trip
  geometry are not included in the published plugin or repository.

---

# Validation — Maps Directions 0.5.0

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 27 October 2026.

- All 193 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- The actual working map and legend display four clearly different categorical
  colors (blue, orange, teal and magenta), replacing the earlier similar hues.
  Line, arrow, fallback and access colors continue to share the same assignment.
- Existing cached road paths appeared immediately after loading the addon.
  Missing connections prepared automatically without pressing a button; the job
  completed, saved retry cooldowns for unresolved connections and released its
  temporary map. The original map camera was not changed.
- A second reload restored cached paths and five recent failed-attempt cooldowns.
  It scheduled no automatic timer or background job and allocated no hidden map.
- The themed native UI hides the Prepare button completely in automatic mode.
  Progress and Cancel remain available during work; disabling automatic mode
  restores manual preparation. New settings and commands are English.
- Regression coverage includes debounce, cached-first rendering, current input
  cancellation, hidden-view suppression, Cancel/resume, manual retry, stable
  palette assignments during filtering, contrast, and bounded palette history.
- Shared queue tests cover both positive path reuse and negative cooldown reuse
  after waiting for another view, with one active temporary map including cleanup.
- Retry metadata uses bounded hashes and timestamps, without source URLs, group
  labels or additional note contents. Existing geometry cache data remains readable.
- New background data can use network, CPU, GPU memory and battery. Preparation
  remains bounded and walking-oriented; automatic mode does not guarantee routes
  for disconnected, ferry, flight or unavailable road connections.
- No personal vault files or cached routes are shipped. Existing base settings,
  marker appearance and official Maps rendering remain under Maps control.

---

# Validation — Maps Directions 0.4.0

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 27 October 2026.

- All 161 automated tests pass; strict TypeScript and production installation ZIP pass.
- The actual working Map view displays four group labels and their rendered line
  colors in the compact Routes legend, separate from the connection progress count.
- Prepare road routes runs from one explicit click. It processed 46 areas in the
  background, found five additional paths, displayed progress/Cancel and a completed
  result. Both the center and zoom of the visible map remained exactly unchanged.
- The temporary preparation map and its host were removed after completion.
- Found paths were preserved during installation. Reloading the addon at overview
  zoom restored saved geometry without detailed roads being visible.
- Regression coverage includes source-only style extraction without marker/note
  data, temporary map reuse/cleanup, bounded deadlines, cancellation during loading
  and routing, callback backpressure, early completion, endpoint matching, stale
  worker rejection, view/style/input lifecycle changes and property color updates.
- Planner tests cover overlap, near-map ordering, long-distance endpoint limits,
  date-line crossings and area caps. Road cache, accumulated detail, alternative
  connected-network snapping and safe legend/status DOM rendering are also covered.
- Normal rendering reads loaded road data locally. Explicit preparation can load
  extra tile/metadata data from the existing Maps background provider; there is no
  separate routing service, API key or bundled map renderer. Cached route geometry
  is stored locally; detailed road geometry remains bounded in memory.
- Connections not found in the available walking network remain dashed. This
  approximate mode does not invent ferry, flight or missing road connections.
- Original Maps markers, icons, marker colors, background and base settings remain
  under Maps control. No personal vault files or cached routes are shipped.

---

# Validation — Maps Directions 0.3.0

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 27 October 2026.

- All 92 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- All added options now belong to the single English Directions group.
- Actual native UI switches between Single color, Random by route and Color property.
  Single color shows the existing Line color selector; property mode shows the
  Color property selector; random mode hides both dependent inputs immediately.
- The two grouped local-demo routes render in distinct automatic colors. Single
  color restores the saved Violet color; property mode reads RouteColor and uses
  the configured blue/orange examples. Original Maps marker colors stay unchanged.
- With direction arrows enabled, their bitmap colors match the corresponding route.
  The original arrow visibility preference was restored after the visual check.
- Regression tests verify solid/fallback/access color consistency, per-color image
  cleanup on mode changes/style reload/unload, and that color edits preserve local
  road geometry without a new road search or query.
- Pure model tests cover stable group colors across ordering/filtering/reload,
  numeric Sequence/path property precedence, invalid/missing values and CSS formats.
- Sequence remains optional and cleared selections stay empty. Existing zoom/pan
  road-geometry retention continues to pass all prior regressions.
- Demo notes include an independent RouteColor property and the Stops table exposes
  it. Existing Sequence, grouping, marker styles and the original empty view remain.

Routing and original map ownership are unchanged. No routing API, extra tile
request, telemetry or persistent road database was added. Mobile visual testing
and future upstream compatibility remain pending.

---

# Validation — Maps Directions 0.2.2

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 26 October 2026.

- All 78 automated tests pass; strict TypeScript, production build and installation ZIP pass.
- Sequence property has neither a settings default nor a runtime fallback. Missing,
  cleared and invalid selections remain unselected. Explicit selections are retained.
- In actual Obsidian, selecting Sequence showed connections, clearing it removed them,
  and closing/reopening the same map preserved the empty field and marker-only view.
  Connect markers remained enabled throughout this check.
- The English Route mode dropdown is inside Directions. There is no separate
  Routing group; original Maps Display, Markers and Background groups remain.
- A Separate routes example view in the local demo uses Route = Day 1 / Day 2.
  Four markers form two independent road connections, with no connection between
  groups. Actual routing diagnostics reported 2/2 found road paths.
- The Stops table displays Route alongside Sequence. Existing Sequence values were
  preserved, and the original Local roads view retains its empty sequence selection.
- Newly generated local demos contain the grouping example and a fourth public
  example stop. Existing demo files are not overwritten by the demo command.

The local road-routing limitations and retained in-memory geometry are unchanged.
Mobile visual testing and future upstream compatibility remain pending.

---

# Validation — Maps Directions 0.2.1

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 26 October 2026.

- All 75 automated tests pass; strict TypeScript, bundling and installation ZIP pass.
- In actual Obsidian, the local Tokyo demo found both road paths. After several
  zoom-out steps to a wider city overview, both paths retained their road shapes
  and direction arrows. Diagnostics still reported 2/2 road paths and no fallback.
- Six regression tests cover exact geometry retention across zoom 13 and 6,
  panning, style reload and map recreation; partial-route worker result indexing;
  failures/null results preserving existing successes; changed endpoints and
  reversed Sequence; pending searches at zoom-out; and stale replies.
- Successful geometry is matched by ordered endpoint coordinates. Current marker
  properties and access segments are regenerated; obsolete connections are removed.
- The cache belongs to the open view, stays in memory, and is destroyed with it.
  Unresolved connections still need detailed loaded roads for their first search.
- Original Maps markers, styling and background loading remain unchanged.

No on-disk route database, additional tile download or routing service was added.
Mobile visual testing and future upstream compatibility remain pending.

---

# Validation — Maps Directions 0.2.0

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 26 October 2026.

- All 69 automated tests pass: adapter, ordering, road collection, road graph,
  bundled worker, worker lifecycle and overlay ownership/cancellation.
- Strict TypeScript compilation, production bundling and installation ZIP pass.
- Native UI retains original Display, Markers and Background groups and appends
  Directions, Routing and Connection style. All added UI is English.
- The Routing dropdown switches between Straight line and Follow roads (local).
- The separate local demo creates three public example stops around Tokyo Station.
  Existing notes and the original Japan demo are not overwritten.
- Both consecutive local-demo connections followed loaded roads in actual Maps,
  with bends and arrows. The diagnostic command reported 2/2 road paths and no
  straight fallback, using 32,791 road nodes in the loaded detailed map.
- Switching to Straight line restored two direct connections. Switching back
  restored road paths. Original colored markers and the OpenFreeMap background
  remained in place throughout.
- Before road data is ready, or when no path is available, the overlay shows dashed
  straight fallback rather than a solid claimed road route. Unsupported/raster
  sources and overview zoom are covered by automated tests.
- A dense-fragment regression covers the spatial-index issue found during actual
  Tokyo verification. No bridge-crossing rules were relaxed to fix it.
- Work runs in a locally bundled Blob worker. Directions adds no routing API,
  network request, API key, offline-area download or persistent road database.
- Worker cancellation, replaced-worker errors, stale results, disable, unload,
  style reload and repeated idle events are covered by meaningful lifecycle tests.
- Source and release files contain no personal vault notes or machine-specific paths.

The paths are approximate and walking-oriented, limited to detailed loaded vector
roads. Complete OSM topology, driving restrictions and global optimality are not
provided. Mobile visual testing and future upstream compatibility remain pending.

---

# Validation — Maps Directions 0.1.0

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 25 October 2026.

- All 36 automated tests pass (adapter, geometry and overlay ownership).
- Strict TypeScript compilation, production bundling and installation ZIP passed.
- Native UI displays original Display, Markers and Background groups plus Directions and Connection style.
- The demo uses the official Map layout, original colored icons, original OpenFreeMap background and original Map controls.
- Direction arrows were visually verified for all three consecutive connections.
- Turning Connect markers off removed only connections; original markers and map remained visible. Re-enabling restored connections.
- Changing Kyoto Sequence from 2 to 5 rebuilt the three connections live while retaining original marker appearance.
- Splitting the four demo stops into two groups removed the connection between groups.
- Demo test changes were restored afterward.
- Enabling/reloading the addon attaches to an existing original Map view.
- Source contains no vault notes, credentials or machine-specific paths. Demo notes are synthetic examples.

The adapter includes a regression test for the real Bases factory lifecycle:
view configuration is assigned after the view factory returns. Attachment waits
for that assignment and cancels safely if the view or addon unloads first.

Mobile visual testing and future upstream version compatibility remain pending.
