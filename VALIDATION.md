# Validation — Maps Directions 0.1.0

Validated on macOS, Obsidian 1.14.4, official Maps 0.2.2, 25 October 2026.

- All 36 automated tests pass (adapter, geometry and overlay ownership).
- Strict TypeScript compilation, production bundling and installation ZIP passed.
- Native UI displays original Display, Markers and Background groups plus Directions and Connection style.
- The demo uses the official Map layout, original colored icons, original OpenFreeMap background and original Map controls.
- Direction arrows were visually verified for all three consecutive connections.
- Turning Connect markers off removed only connections; original markers and map remained visible. Re-enabling restored connections.
- Changing Kyoto Sequence from 2 to 5 rebuilt the three connections live while retaining original marker appearance.
- Splitting the four demo stops into two groups removed the connection between groups.
- Demo test changes were restored afterward.
- Enabling/reloading the addon attaches to an existing original Map view.
- Source contains no vault notes, credentials or machine-specific paths. Demo notes are synthetic examples.

The adapter includes a regression test for the real Bases factory lifecycle:
view configuration is assigned after the view factory returns. Attachment waits
for that assignment and cancels safely if the view or addon unloads first.

Mobile visual testing and future upstream version compatibility remain pending.
