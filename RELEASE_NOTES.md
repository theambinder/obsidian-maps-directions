# Maps Directions 0.4.0

Testing prerelease for official Maps 0.2.2.

- Add a compact, collapsible Routes legend showing each Separate routes by group
  and its actual line color. Blank values appear as Ungrouped.
- Show Road routes: N/total on local maps. This counts adjacent-stop connections,
  while the legend lists route groups. Access connectors are excluded from the count.
- Add Prepare road routes to load detailed road areas automatically in the
  background. Show area progress, cancellation and a completion result, without
  moving the visible map or requiring manual zooming and panning.
- Reuse the installed Maps runtime in one temporary hidden map with a 32-tile
  cache. Load only the current background's transport vector sources; copy no
  marker sources, note data, sprites or icons.
- Limit each preparation to 64 areas, eight seconds of load waiting per area,
  two minutes overall and at most 200 unresolved connections. Long intercity
  legs receive endpoint detail only. Release the temporary map after completion
  or cancellation; keep paths already found.
- Accumulate detailed road geometry within fixed memory limits for the open view.
- Try nearby alternative road snaps within 100 m when the nearest road is isolated.
- Save found path geometry automatically and reuse it after reopening the view
  or restarting Obsidian when endpoint coordinates still match.
- Bound the local geometry cache to 500 paths and 100,000 total vertices, with
  oldest created or updated paths pruned first. No road database is persisted.

Original Maps markers, icons, marker colors and backgrounds remain controlled by
Maps. Existing route color modes and the single Directions settings group remain
available. Directions adds no routing service, API key or bundled map engine.
Explicit preparation can make additional tile and metadata requests to the current
background's existing vector source providers. Internet is needed for areas absent
from Maps cache; saved route lines remain locally reusable.

Local routing remains approximate. Roads visible at a wide zoom can lack the
connected detail needed for a new calculation. Preparation automates loading that
detail, but disconnected paths, ferry, flight and distant connections may still
use dashed straight lines. Complete routing for every connection is not
guaranteed. The addon uses undocumented Maps/Bases internals; mobile visual
validation is pending.
