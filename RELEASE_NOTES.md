# Maps Directions 0.3.0

Testing prerelease for official Maps 0.2.2.

- Add Line color mode: Single color, Random by route and Color property.
- Show the existing Line color selector only in Single color mode and the color
  property selector only in Color property mode.
- Give route groups stable automatic colors based on Separate routes by.
- Use the first valid property color in Sequence order for each route, with the
  saved single color as the fallback for missing or invalid values.
- Match route colors across lines, road paths, dashed segments and direction arrows.
- Place all addon settings, including line appearance, in the single Directions group.
- Keep existing single-color choices, optional Sequence selection and retained
  road geometry. Color changes do not require a new road search.

Original Maps markers, icons, marker colors and backgrounds remain controlled by
Maps. Automatic colors stay consistent across camera changes and reopening the
view. Property colors normalize to opaque RGB; Line opacity controls transparency.

Local routing remains approximate and uses detailed roads loaded by Maps for a
connection's first calculation. There is no new routing service, additional tile
download or persistent offline route database. The addon uses undocumented
Maps/Bases internals; mobile visual validation is pending.
