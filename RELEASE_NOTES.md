# Maps Directions 0.6.2

Testing prerelease for official Maps 0.2.2. Algorithm tuning remains in the 0.6.x
release series.

- Automatically switch resource-limited whole-connection searches to smaller
  overlapping road sections within the current processing mode. Eco remains the
  default, with its existing budgets and pause; this fallback does not require
  manually pressing Resume after the working-data limit.
- Select several real road crossings at each section boundary. Join verified
  paths only through anchors matching road level, direction and at most 5 cm
  projection error. Internal joins cannot use the configurable pin-access allowance to
  jump to a nearby road, a perpendicular crossing, or another bridge/tunnel level.
- Add global **Maximum pin-to-road access (m)**, default **250 m**, with an
  explicit **0–1000 m** range instead of the previous fixed 100 m allowance.
  Access between the original pin and its selected allowed road is an unverified
  dashed connector. Larger values can choose the wrong road or side of a barrier
  and require an unverified walk; internal road sections keep their strict anchors.
  Changing the allowance retries unresolved searches when automatic preparation
  is enabled and resets active section prefixes; completed saved paths and
  existing pauses are kept.
- Connect geometric intersections between ground roads on the same level even
  without a source vertex at the crossing. Keep bridge/tunnel levels separate,
  and preserve original endpoint provenance so clipping cannot invent a junction.
- Clip loaded roads to the current window before counting working-data limits.
  Release local road data and the worker graph between windows, instead of
  accumulating the whole connection's road network.
- Prioritize shorter queued connections. Reuse the reverse of a saved undirected
  walking path only from the same map source and within current pin-access limits.
- Save the section plan, verified path prefixes and frontier. Closing or
  interrupting the map keeps those checkpoints; automatic processing continues
  from the saved frontier when the map opens again.
- Upgrade only known resource-limit pauses from earlier versions to the new
  strategy. Explicit user pauses and unrecognized failures stay paused.
- Try up to three progressively wider corridors with shorter steps. If a
  connected route still cannot be assembled, report Data unavailable with an
  explanation. This is not proof that no real walking path exists, and the finite
  corridor/candidate search cannot guarantee every route or a globally shortest
  path.
- Keep the default maximum routing distance at 30 km. Above-threshold connections
  remain straight and excluded from eligible progress; saved complete paths,
  processing preferences and the separate storage counters remain available.

Smaller road graphs bound retained working data, but do not guarantee lower peak
CPU use. Additional tile loading, graph construction and saved-prefix writes can
increase total calculation time, network activity, shared HTTP cache size and
addon data size. No shared cache is cleared. The saved-data and shared-cache
counters keep their separate scopes; neither measures total application disk use.

Original Maps markers, backgrounds, route colors and arrows remain under their
existing controls. Local walking routing is approximate; this release does not
add driving directions, a routing service or an offline road database.
