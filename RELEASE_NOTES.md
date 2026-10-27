# Maps Directions 0.6.4

Testing prerelease for official Maps 0.2.2.

- Collapse the map status panel to processed/remaining progress only. Expand that
  row for found routes, skipped long connections, status, Pause/Resume, reasons,
  CPU/RAM and saved-data size. Distance-excluded connections stay outside progress.
- Set the default **Connect pins to roads within (m)** allowance to **300 m**.
  Existing explicitly saved preferences remain unchanged.
- Recognize shared roads despite millimetre coordinate rounding and short section
  seam vertices. Replace brittle exact-bearing comparison with a bounded parallel
  check while retaining the conservative 10 cm position tolerance. Shared runs
  keep distinct visual lanes and matching arrow offsets for different groups,
  reversed travel and three or more traversals.
- Snap overlap cuts at nearly identical endpoints to avoid tiny centered gaps
  between consecutive shared road pieces. Saved road geometry, route distances,
  original Maps pins and backgrounds keep their coordinates and settings.
