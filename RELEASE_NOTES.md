# Maps Directions 0.2.1

Testing prerelease for official Maps 0.2.2.

- Keep a found local road path visible when zooming out or panning away from
  detailed road tiles.
- Restore matching road paths after a map style reload while the view stays open.
- Reuse retained paths only for current connections with matching endpoints;
  moved stops and changed Sequence or route groups update the displayed chain.
- Keep existing Maps markers, backgrounds, route modes and connection styling.

The first calculation for a new or unresolved connection still requires detailed
loaded roads (zoom level 14 or closer). Retained geometry lives in memory while
the Maps view is open; it is not a persistent offline route cache. No routing API,
key, server or additional tile download is introduced.

Local road paths remain approximate and walking-oriented. Missing paths use
dashed straight fallback. Complete driving restrictions, turn-by-turn navigation
and traffic remain outside this experimental mode.

The addon relies on undocumented Maps/Bases internals. Future upstream updates
may require an adapter update. Mobile visual validation is pending.
