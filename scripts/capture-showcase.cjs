// Reproducible documentation screenshot using generated geometry and the real UI.
const fs = require('node:fs');
const path = require('node:path');
module.exports = async function captureShowcase(api, root, previousLibraryId, waitFor) {
  const THREE = await import('three');
  const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
  const exporter = new STLExporter();
  const directory = path.join(root, 'Print collection');
  fs.mkdirSync(directory);
  const vase = new THREE.LatheGeometry([
    [0, 0], [23, 0], [25, 4], [28, 15], [30, 30], [24, 48],
    [16, 62], [15, 74], [17, 78], [14, 78], [12, 73], [13, 62],
    [21, 47], [27, 30], [25, 16], [21, 5], [0, 5]
  ].map(([x, y]) => new THREE.Vector2(x, y)), 64);
  const gear = new THREE.Shape();
  for (let i = 0; i < 64; i++) {
    const angle = i / 64 * Math.PI * 2;
    const radius = i % 4 < 2 ? 32 : 26;
    const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
    i ? gear.lineTo(x, y) : gear.moveTo(x, y);
  }
  gear.closePath();
  const hole = new THREE.Path(); hole.absarc(0, 0, 10, 0, Math.PI * 2, true); gear.holes.push(hole);
  const shapes = [
    ['Contour vase.stl', vase],
    ['Knot sculpture.stl', new THREE.TorusKnotGeometry(24, 7, 160, 20)],
    ['Drive gear.stl', new THREE.ExtrudeGeometry(gear, { depth: 10, bevelEnabled: true, bevelThickness: 1, bevelSize: 1, bevelSegments: 2 }).rotateX(-Math.PI / 2)],
    ['Faceted planter.stl', new THREE.LatheGeometry([[0, 0], [20, 0], [30, 45], [27, 45], [18, 4], [0, 4]].map(([x, y]) => new THREE.Vector2(x, y)), 10)],
    ['Calibration sphere.stl', new THREE.IcosahedronGeometry(28, 1)],
    ['Orbit ornament.stl', new THREE.TorusGeometry(26, 6, 20, 80)],
    ['Low-poly cone.stl', new THREE.ConeGeometry(28, 65, 8)],
    ['Desk bowl.stl', new THREE.LatheGeometry([[0, 0], [12, 0], [27, 10], [36, 25], [33, 25], [24, 12], [10, 4], [0, 4]].map(([x, y]) => new THREE.Vector2(x, y)), 48)]
  ];
  for (const [name, geometry] of shapes) {
    geometry.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geometry); mesh.updateMatrixWorld(true);
    const data = exporter.parse(mesh, { binary: true });
    fs.writeFileSync(path.join(directory, name), Buffer.from(data.buffer, data.byteOffset, data.byteLength));
    geometry.dispose();
  }
  await api.ipc('removeLibrary', { id: previousLibraryId });
  const added = await api.ipc('addLibrary', { mountPath: directory });
  if (!added.ok) throw new Error(added.error);
  const libraryId = added.library.id;
  const files = await waitFor('showcase thumbnails', async () => {
    const rows = await api.ipc('queryFiles', { libraryId });
    return rows.length === shapes.length && rows.every(row => row.hasThumb) ? rows : false;
  });
  const vaseFile = files.find(row => row.relPath === 'Contour vase.stl');
  if (!vaseFile) throw new Error('Showcase vase missing');
  await api.ipc('setFileNotes', libraryId, vaseFile.id, 'Smooth contour vase · 78 mm tall\nReady for a first test print in matte PLA.');
  await api.ipc('setFileRatings', libraryId, [vaseFile.id], 5);
  await api.ipc('setFileColorLabels', libraryId, [vaseFile.id], 'green');
  await api.ipc('addTagToFile', libraryId, vaseFile.id, 'Home decor');
  await api.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await api.send('Page.reload');
  await waitFor('showcase tile', () => api.evaluate(`(() => { const tile = [...document.querySelectorAll('[title]')].find(el => el.title === 'Contour vase.stl'); if (!tile) return false; tile.click(); return true; })()`));
  await new Promise(resolve => setTimeout(resolve, 5000));
  const screenshot = await api.send('Page.captureScreenshot');
  fs.writeFileSync(path.resolve(process.env.STL_SHERPA_SHOWCASE), Buffer.from(screenshot.data, 'base64'));
};
