# Maps Directions 0.6.3

Testing prerelease for official Maps 0.2.2.

- Add an automatic walking-detour fallback after straight section corridors fail.
  Two bounded overview captures search for a guide, then small detailed windows
  follow its bends and backward travel. Only complete verified detailed paths
  become routes; coarse guide geometry is never accepted as the final result.
- Persist detour guides and verified detailed prefixes. Keep Eco's working-data
  budgets and pauses, and release the local graph between windows. Known section
  failures from 0.6.2 automatically get one guided attempt when preparation is on;
  user pauses and current terminal failures do not enter a retry loop.

- Separate overlapping road-route strokes into parallel visual lanes, with matching
  colors and direction arrows. Saved road geometry and original Maps pins keep
  their coordinates.
- Simplify the map panel to found routes, processed connections, remaining
  percentage, skipped long connections and a short status. **Pause/Resume** stays
  available. Distance-excluded connections remain outside calculation progress.
- Move loader counts, reasons, CPU/RAM and saved-data size into collapsed
  **Details**. Resource updates do not rewrite unchanged visible progress.
- Remove the shared HTTP-cache counter from the map and settings, together with
  its periodic sampling.
- Rename the global pin-access control to **Connect pins to roads within (m)**.
  Its explanation describes the dashed access from an off-road pin, the
  0–1000 m range and the risk of crossing a barrier or choosing the wrong road.

The routing distance, pin-access allowance, processing mode and pause keep their
existing values. Changing the pin-access allowance queues unresolved searches
again when automatic preparation is enabled; saved complete routes and existing
pauses are kept.
