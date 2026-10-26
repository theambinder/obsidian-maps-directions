# Maps Directions 0.2.0

Testing prerelease for official Maps 0.2.2.

- Add a Routing group with Straight line and experimental Follow roads (local) modes.
- Search road geometry already loaded by supported OpenMapTiles vector backgrounds.
- Keep Sequence order and separate route groups; show unavailable road connections as straight dashed lines.
- Calculate locally without API keys, a routing server or extra tile requests.
- Preserve original Maps markers, icons, colors, backgrounds and existing settings.
- Keep Straight line as the default for existing bases.
- Add Open local roads demo and Check local routing commands.
- Run bounded graph construction and path search in a bundled background worker.

Local road paths are approximate and limited to available map detail and coverage.
This release does not save offline areas or include a persistent road database.
Complete driving restrictions, turn-by-turn navigation and traffic are outside
this experimental mode. Raster and unsupported vector sources use dashed fallback
connections.

The addon relies on undocumented Maps/Bases internals. Future upstream updates
may require an adapter update. Mobile visual validation is pending.
