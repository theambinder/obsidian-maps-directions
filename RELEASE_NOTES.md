# Maps Directions 0.6.1

Testing prerelease for official Maps 0.2.2. Algorithm tuning remains in the 0.6.x
release series.

- Add global Maximum road-routing distance (km), default 30. Use the straight-line
  great-circle separation between consecutive markers before loading road data.
  Connections strictly above the threshold stay straight without a road search;
  0 disables the threshold. Exactly-at-threshold connections remain eligible.
- Distinguish intentional straight connections from No walking path and Data
  unavailable. Show their count separately as Skipped by distance. Exclude them
  from both the processed count and eligible total used for road-processing
  percentages; they are not counted as found paths or failed searches.
- Show processed eligible connections, remaining eligible count and percentage
  remaining. All eligible work finished means 100%; an all-distance-excluded
  map has nothing to calculate and shows zero remaining, without a false failure.
- Apply the preference to queued and already calculated connections. Keep saved
  road geometry so increasing or disabling the threshold can restore existing
  results; newly eligible connections enter the normal saved queue.
- Preserve the distance preference when changing processing mode or pause. Eco
  and the one-second default pause remain unchanged.
- Track the logical size of Maps Directions data.json and its signed change
  since the first successful measurement in the current plugin session. Measure
  the actual saved file after writes rather than presenting RAM estimates as
  disk use. Unsupported measurements remain unknown.
- Add a separate Shared HTTP cache counter when Electron's current-session
  cache-size API is available. Show reported cache bytes and the signed change
  since the first successful measurement in the current plugin session. This
  includes all HTTP resources in the shared Obsidian browser session, not only
  Maps or Directions requests; unavailable APIs remain unknown rather than zero.
- Keep storage scopes explicit. The addon saves queue/progress and route geometry;
  temporary working road networks remain in RAM. Chromium may retain tile
  responses according to cache policy. The shared cache is not included in the
  saved-data counter and cannot be attributed to route preparation alone. Neither
  logical counter is a claim about physically allocated disk blocks or complete
  application disk use. No shared cache is cleared.

Original Maps markers, backgrounds, route colors and arrows remain under their
existing controls. Local walking routing is approximate; this release does not
add driving directions, a routing service or an offline road database.
