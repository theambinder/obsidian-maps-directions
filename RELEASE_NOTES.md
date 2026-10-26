# Maps Directions 0.2.2

Testing prerelease for official Maps 0.2.2.

- Keep Sequence property empty after clearing it and reopening the map. A missing
  or cleared selection draws no connections, even when notes contain Sequence.
- Preserve explicitly saved Sequence property selections.
- Move Route mode into Directions and remove the separate Routing settings group.
- Explain Separate routes by with independent Route groups and per-group ordering.
- Include a separate grouping view and Route column in newly generated local demos.
- Preserve retained road paths across zoom and viewport changes while the view is open.

New or unresolved local road connections still need detailed loaded roads for
first calculation. Retained geometry stays in memory for the open view; no
persistent offline route cache, routing API or extra tile download is introduced.

The addon relies on undocumented Maps/Bases internals. Future upstream updates
may require an adapter update. Mobile visual validation is pending.
