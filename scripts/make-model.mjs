// Writes public/models/generic.glb: a flat-shaded low-poly bus at real size in metres, glTF Y-up,
// nose toward +Z, base at y=0. Run with `node scripts/make-model.mjs`.
import { mkdirSync, writeFileSync } from "node:fs";

const W = 1.3, H = 3, L = 6, NOSE = 1.5, BELT = 1.6;
const P = {
  bl: [-W, 0, -L], br: [W, 0, -L], fl: [-W, 0, L], fr: [W, 0, L],
  ml: [-W, BELT, L], mr: [W, BELT, L],
  tfl: [-W, H, L - NOSE], tfr: [W, H, L - NOSE],
  tbl: [-W, H, -L], tbr: [W, H, -L],
};
const polygons = [
  [P.bl, P.br, P.fr, P.fl],
  [P.bl, P.tbl, P.tbr, P.br],
  [P.tbl, P.tfl, P.tfr, P.tbr],
  [P.ml, P.mr, P.tfr, P.tfl],
  [P.fl, P.fr, P.mr, P.ml],
  [P.bl, P.fl, P.ml, P.tfl, P.tbl],
  [P.br, P.tbr, P.tfr, P.mr, P.fr],
];

const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => a.map((v) => v / Math.hypot(...a));
const CENTER = [0, H / 2, 0];

const pos = [], nor = [], idx = [];
for (let poly of polygons) {
  let n = norm(cross(sub(poly[1], poly[0]), sub(poly[2], poly[0])));
  // Winding is fixed up here instead of by hand: the hull is convex, so outward is away from its centre.
  if (dot(n, sub(poly[0], CENTER)) < 0) {
    poly = [...poly].reverse();
    n = n.map((v) => -v);
  }
  const base = pos.length / 3;
  for (const p of poly) pos.push(...p), nor.push(...n);
  for (let i = 1; i < poly.length - 1; i++) idx.push(base, base + i, base + i + 1);
}

const posBuf = Buffer.from(new Float32Array(pos).buffer);
const norBuf = Buffer.from(new Float32Array(nor).buffer);
const idxBuf = Buffer.from(new Uint16Array(idx).buffer);
const pad4 = (n) => (4 - (n % 4)) % 4;
const bin = Buffer.concat([posBuf, norBuf, idxBuf, Buffer.alloc(pad4(idxBuf.length))]);

const gltf = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length },
    { buffer: 0, byteOffset: posBuf.length, byteLength: norBuf.length },
    { buffer: 0, byteOffset: posBuf.length + norBuf.length, byteLength: idxBuf.length },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: [-W, 0, -L], max: [W, H, L] },
    { bufferView: 1, componentType: 5126, count: nor.length / 3, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: idx.length, type: "SCALAR" },
  ],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc(pad4(json.length), 0x20)]);
const chunk = (buf, type) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(buf.length, 0);
  head.writeUInt32LE(type, 4);
  return Buffer.concat([head, buf]);
};
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
mkdirSync("public/models", { recursive: true });
writeFileSync("public/models/generic.glb", Buffer.concat([header, chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)]));
