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
