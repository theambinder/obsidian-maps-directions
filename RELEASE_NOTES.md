# Maps Directions 0.5.0

Testing prerelease for official Maps 0.2.2.

- Replace independent random hues with a categorical palette that chooses
  contrasting colors for simultaneous route groups. Preserve assignments while
  the view stays open, including filtering groups out and back in. The same full
  group set has deterministic assignments on reopening; an initially filtered
  subset or newly introduced groups can produce different assignments.
- Enable Automatically prepare roads by default in Follow roads (local) mode.
  Show saved paths immediately, then prepare missing connections in the background
  after the visible view has stayed stable for about 750 ms. No prepare button is
  required in automatic mode. The visible map remains in place.
- Share a serial preparation queue across views, with progress and Cancel. Keep
  found paths when work is stopped. Turning automatic preparation off restores
  the manual Prepare road routes button.
- Persist automatic retry cooldowns: 24 hours for a connection with no found path,
  15 minutes for unavailable data, incomplete preparation or failed attempts. Cancelling suppresses the
  current view's attempt until reopening or a connection input change.
- Add Maps Directions: Retry missing road routes to retry without waiting for
  a cooldown. Panning, zooming, line color changes and style reloads do not by
  themselves trigger another preparation pass.
- Keep the existing bounded preparation: one temporary map, a 32-tile cache,
  64 areas, eight seconds of load waiting per area, two minutes per active job
  and at most 200 unresolved connections. Long journeys receive endpoint detail.
- Retain the 500-path/100,000-vertex persistent geometry cache, route legend,
  property colors and all original Maps marker and background behavior.

Automatic preparation can add tile and metadata requests to the current
background's existing vector source providers when a local map opens. New areas
can use network bandwidth, CPU, GPU memory and battery; saved paths, the shared
queue and cooldowns avoid unnecessary repeated work. Disable automatic preparation
for manual control. Internet is needed for data absent from Maps cache.

There is no additional routing service, API key or bundled map engine. Attempt
cooldowns store hashed identifiers and times locally, without raw source URLs or
group labels. No road database is persisted. Local walking routing remains
approximate; disconnected paths, ferries, flights and unavailable detail can
leave dashed connections. Complete routing for every connection is not guaranteed.
The addon uses undocumented Maps/Bases internals; mobile visual validation is pending.
