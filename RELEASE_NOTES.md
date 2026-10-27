# Maps Directions 0.6.0

Testing prerelease for official Maps 0.2.2.

- Replace whole-itinerary cut-offs with a saved per-connection queue. Process
  connections in small chunks without silently discarding the remaining trip
  after 64 map areas, 200 connections or two minutes.
- Persist task state, reasons, area plans and completed route geometry. Previously
  completed connections stay available after reopening or restarting. An unfinished
  connection rebuilds its temporary road network; a user-paused task stays paused.
- Show processed percentage and percentage remaining separately from the count
  of found road paths. Distinguish Queued, Preparing, Ready, No walking path,
  Data unavailable and Paused. Processing completion does not promise every route
  was found.
- Add Pause/Resume. A working-data or computation limit pauses the affected
  connection with an explicit reason while other queued connections can continue.
  Resume uses the current processing mode and does not silently raise budgets.
- Add global Settings → Maps Directions controls for Processing mode and Pause
  between chunks. Default Eco uses two areas per chunk, a one-second pause,
  a 768 × 512 viewport, eight cached tiles and up to 6,000 road lines/50,000
  coordinates. Balanced and Maximum offer larger working profiles.
- Use adaptive per-connection overview, corridor and endpoint plans, replacing
  the silent 30 km endpoint-only rule. Split dense areas into smaller views up to
  zoom 16; report insufficient regional detail or working-data limits honestly.
- Store durable completed paths in the trip ledger, independently of the bounded
  opportunistic cache. There is no silent 500-path eviction of completed trip data.
- Show available CPU and private-memory measurements for the Obsidian window
  process, including other plugins. CPU 100% equals one core equivalent and can
  exceed 100%; memory uses MiB. GPU and other application processes are excluded.
- Preserve original Maps markers, backgrounds, categorical route colors, arrows
  and the route legend. No separate routing service or map engine is bundled.

Preparing road data can use network bandwidth, CPU, GPU memory and battery.
Processing mode describes concrete working limits, not a guaranteed CPU or RAM
percentage. Eco reduces average activity through smaller work and pauses; it can
still briefly occupy a core. Queue metadata and saved paths grow on disk with
completed work, while temporary road networks are not saved to disk.

Map background data may be fetched from the current provider when absent from
Maps cache. Walking routing remains approximate. Coarse regional geometry,
missing connections, ferries and transport legs can remain unresolved even after
all queued connections are processed. Correct automobile navigation is not added
in this release. Mobile visual validation is still pending.
