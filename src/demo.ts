import { App, TFile } from 'obsidian';

export const DEMO_FOLDER = 'Bases/Maps Directions Demo';
const STOPS = [
  ['01 Tokyo', 35.681236, 139.767125, 'train-front', '#2583e8'],
  ['02 Kyoto', 34.985849, 135.758766, 'landmark', '#7c5cff'],
  ['03 Osaka', 34.702485, 135.495951, 'building-2', '#ef8733'],
  ['04 Hiroshima', 34.397685, 132.475217, 'flower-2', '#159b80'],
] as const;

export async function openDirectionsDemo(app: App): Promise<void> {
  let path = '';
  for (const part of DEMO_FOLDER.split('/')) {
    path = path ? `${path}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
  }
  for (const [index, [name, latitude, longitude, icon, color]] of STOPS.entries()) {
    const notePath = `${DEMO_FOLDER}/${name}.md`;
    if (!app.vault.getAbstractFileByPath(notePath)) {
      await app.vault.create(notePath, `---\ncoordinates: [${latitude}, ${longitude}]\nSequence: ${index + 1}\nRoute: Japan demo\nicon: ${icon}\ncolor: "${color}"\n---\n\n# ${name.slice(3)}\n\nDemo stop for Maps Directions. Edit **Sequence** in the **Stops** view to change the connections. Markers, icons and colors are rendered by the official Maps plugin.\n`);
    }
  }
  const basePath = `${DEMO_FOLDER}/Maps Directions Demo.base`;
  if (!app.vault.getAbstractFileByPath(basePath)) {
    await app.vault.create(basePath, `filters:\n  and:\n    - 'file.inFolder("${DEMO_FOLDER}")'\n    - 'file.ext == "md"'\nviews:\n  - type: map\n    name: Map\n    coordinates: note.coordinates\n    markerIcon: note.icon\n    markerColor: note.color\n    order:\n      - file.name\n      - note.Sequence\n      - note.Route\n    directionsEnabled: true\n    directionsSequence: note.Sequence\n    directionsRoute: note.Route\n    directionsArrows: true\n  - type: table\n    name: Stops\n    order:\n      - file.name\n      - note.Sequence\n      - note.Route\n      - note.coordinates\n      - note.icon\n      - note.color\n    sort:\n      - property: note.Sequence\n        direction: ASC\n`);
  }
  const file = app.vault.getAbstractFileByPath(basePath);
  if (!(file instanceof TFile)) throw new Error('The demo base path is occupied by a folder.');
  await app.workspace.getLeaf('tab').openFile(file);
}

/** Public example locations, separate from the user's notes and the original demo. */
export async function openLocalRoadsDemo(app: App): Promise<void> {
  const folder = 'Bases/Maps Directions Local Demo';
  let path = '';
  for (const part of folder.split('/')) {
    path = path ? `${path}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
  }
  const stops = [
    ['01 Nihonbashi', 35.68416, 139.77390, 'landmark', '#2583e8', 'Day 1'],
    ['02 Kyobashi', 35.67690, 139.76980, 'building-2', '#ef8733', 'Day 1'],
    ['03 Marunouchi', 35.68100, 139.76470, 'train-front', '#159b80', 'Day 2'],
    ['04 South stop', 35.67880, 139.76430, 'map-pin', '#7c5cff', 'Day 2'],
  ] as const;
  for (const [index, [name, latitude, longitude, icon, color, route]] of stops.entries()) {
    const notePath = `${folder}/${name}.md`;
    if (!app.vault.getAbstractFileByPath(notePath)) await app.vault.create(notePath,
      `---\ncoordinates: [${latitude}, ${longitude}]\nSequence: ${index + 1}\nRoute: ${route}\nicon: ${icon}\ncolor: "${color}"\n---\n\n# ${name.slice(3)}\n\nPublic example stop for local road connections. In the **Separate routes example** view, **Route** splits the stops into independent days and **Sequence** orders each day.\n`);
  }
  const basePath = `${folder}/Local Roads Demo.base`;
  if (!app.vault.getAbstractFileByPath(basePath)) await app.vault.create(basePath,
    `filters:\n  and:\n    - 'file.inFolder("${folder}")'\n    - 'file.ext == "md"'\nviews:\n  - type: map\n    name: Local roads\n    coordinates: note.coordinates\n    markerIcon: note.icon\n    markerColor: note.color\n    center: "[35.6805, 139.7700]"\n    defaultZoom: 15\n    directionsEnabled: true\n    directionsSequence: note.Sequence\n    directionsRouteMode: local\n    directionsArrows: true\n  - type: map\n    name: Separate routes example\n    coordinates: note.coordinates\n    markerIcon: note.icon\n    markerColor: note.color\n    center: "[35.6805, 139.7700]"\n    defaultZoom: 15\n    directionsEnabled: true\n    directionsSequence: note.Sequence\n    directionsRoute: note.Route\n    directionsRouteMode: local\n    directionsArrows: true\n  - type: table\n    name: Stops\n    order:\n      - file.name\n      - note.Sequence\n      - note.Route\n      - note.coordinates\n      - note.icon\n      - note.color\n    sort:\n      - property: note.Sequence\n        direction: ASC\n`);
  const file = app.vault.getAbstractFileByPath(basePath);
  if (!(file instanceof TFile)) throw new Error('The local roads demo path is occupied by a folder.');
  await app.workspace.getLeaf('tab').openFile(file);
}
