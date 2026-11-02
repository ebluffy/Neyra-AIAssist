// Writes tests/fixtures/neyra-test.vrm: a tiny VRM 1.0 made for tests only.
// One box mesh, the 15 required humanoid bones, blink/aa expressions, CC0.
// Usage (from client/): node scripts/make-test-vrm.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

const bones = {
  hips: [null, [0, 0.9, 0]],
  spine: ['hips', [0, 0.1, 0]],
  chest: ['spine', [0, 0.15, 0]],
  neck: ['chest', [0, 0.2, 0]],
  head: ['neck', [0, 0.1, 0]],
  leftUpperArm: ['chest', [0.18, 0.1, 0]],
  leftLowerArm: ['leftUpperArm', [0.25, 0, 0]],
  leftHand: ['leftLowerArm', [0.25, 0, 0]],
  rightUpperArm: ['chest', [-0.18, 0.1, 0]],
  rightLowerArm: ['rightUpperArm', [-0.25, 0, 0]],
  rightHand: ['rightLowerArm', [-0.25, 0, 0]],
  leftUpperLeg: ['hips', [0.1, -0.05, 0]],
  leftLowerLeg: ['leftUpperLeg', [0, -0.4, 0]],
  leftFoot: ['leftLowerLeg', [0, -0.4, 0]],
  rightUpperLeg: ['hips', [-0.1, -0.05, 0]],
  rightLowerLeg: ['rightUpperLeg', [0, -0.4, 0]],
  rightFoot: ['rightLowerLeg', [0, -0.4, 0]],
};

const names = Object.keys(bones);
const nodes = [];
names.forEach((name) => nodes.push({ name, translation: bones[name][1] }));
names.forEach((name, i) => {
  const parent = bones[name][0];
  if (parent) (nodes[names.indexOf(parent)].children ??= []).push(i);
});
nodes.push({ name: 'Body', mesh: 0 });
nodes.push({ name: 'Root', children: [names.indexOf('hips'), nodes.length - 1] });
const rootIndex = nodes.length - 1;

const positions = new Float32Array([
  -0.2, 0, -0.1, 0.2, 0, -0.1, 0.2, 1.6, -0.1, -0.2, 1.6, -0.1,
  -0.2, 0, 0.1, 0.2, 0, 0.1, 0.2, 1.6, 0.1, -0.2, 1.6, 0.1,
]);
const indices = new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4]);
const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);

const humanoid = Object.fromEntries(names.map((name, i) => [name, { node: i }]));
const json = {
  asset: { version: '2.0', generator: 'neyra make-test-vrm' },
  extensionsUsed: ['VRMC_vrm'],
  extensions: {
    VRMC_vrm: {
      specVersion: '1.0',
      meta: {
        name: 'Neyra test model',
        version: '1',
        authors: ['Neyra tests'],
        licenseUrl: 'https://vrm.dev/licenses/1.0/',
        avatarPermission: 'everyone',
        commercialUsage: 'personalNonProfit',
        creditNotation: 'unnecessary',
        allowRedistribution: true,
        modification: 'allowModification',
      },
      humanoid: { humanBones: humanoid },
      expressions: { preset: { blink: {}, aa: {} } },
    },
  },
  scene: 0,
  scenes: [{ nodes: [rootIndex] }],
  nodes,
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  buffers: [{ byteLength: binary.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
    { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength, target: 34963 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.2, 0, -0.1], max: [0.2, 1.6, 0.1] },
    { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
  ],
};

const pad = (buffer, byte) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, byte)]);
const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
const binChunk = pad(binary, 0);
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
const chunk = (type, body) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(body.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, body]);
};
const out = join(root, 'tests/fixtures/neyra-test.vrm');
mkdirSync(join(root, 'tests/fixtures'), { recursive: true });
writeFileSync(out, Buffer.concat([header, chunk('JSON', jsonChunk), chunk('BIN\0', binChunk)]));
console.log('wrote', out);
