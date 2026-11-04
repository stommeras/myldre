// Writes bus.glb, ferry.glb, train.glb and generic.glb to public/models/: flat-shaded low-poly
// shapes at real size in metres, glTF Y-up, nose toward +Z, base at y=0, origin centered on length
// and width. Run with `node scripts/make-model.mjs`.
import { mkdirSync, writeFileSync } from "node:fs";

/** Side profile [y, z] (convex) extruded across the full width. */
function extrude(halfW, profile) {
  const side = (x) => profile.map(([y, z]) => [x, y, z]);
  const polys = [side(-halfW), side(halfW)];
  for (let i = 0; i < profile.length; i++) {
    const [y0, z0] = profile[i];
    const [y1, z1] = profile[(i + 1) % profile.length];
    polys.push([[-halfW, y0, z0], [halfW, y0, z0], [halfW, y1, z1], [-halfW, y1, z1]]);
  }
  return polys;
}

/** Plan [x, z] (convex) lifted from y0 to y1. */
function prism(plan, y0, y1) {
  const ring = (y) => plan.map(([x, z]) => [x, y, z]);
  const polys = [ring(y0), ring(y1)];
  for (let i = 0; i < plan.length; i++) {
    const [x0, z0] = plan[i];
    const [x1, z1] = plan[(i + 1) % plan.length];
    polys.push([[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]]);
  }
  return polys;
}

/** A side profile with a sloped windscreen, at the front or at both ends. */
const vehicle = ({ halfW, height, halfL, belt, nose, bothEnds }) => {
  const profile = [[0, -halfL], [0, halfL], [belt, halfL], [height, halfL - nose]];
  profile.push(...(bothEnds ? [[height, -halfL + nose], [belt, -halfL]] : [[height, -halfL]]));
  return extrude(halfW, profile);
};

const MODELS = {
  bus: [vehicle({ halfW: 1.3, height: 3, halfL: 6, belt: 1.6, nose: 1.5 })],
  train: [vehicle({ halfW: 1.6, height: 4.2, halfL: 30, belt: 1.5, nose: 4, bothEnds: true })],
  ferry: [
    prism([[-5, -17.5], [5, -17.5], [5, 8], [0, 17.5], [-5, 8]], 0, 2.5),
    prism([[-3.5, -8], [3.5, -8], [3.5, 4], [-3.5, 4]], 2.5, 6),
  ],
  generic: [extrude(1.2, [[0, -4], [0, 4], [2.8, 4], [2.8, -4]])],
};

const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const norm = (a) => a.map((v) => v / Math.hypot(...a));

/** Each part is convex, so outward is away from its own centroid. The winding is fixed against that, not by hand. */
function glb(parts) {
  const pos = [], nor = [], idx = [];
  for (const polys of parts) {
    const verts = polys.flat();
    const centroid = [0, 1, 2].map((k) => verts.reduce((s, v) => s + v[k], 0) / verts.length);
    for (let poly of polys) {
      let n = norm(cross(sub(poly[1], poly[0]), sub(poly[2], poly[0])));
      if (dot(n, sub(poly[0], centroid)) < 0) {
        poly = [...poly].reverse();
        n = n.map((v) => -v);
      }
      const base = pos.length / 3;
      for (const p of poly) pos.push(...p), nor.push(...n);
      for (let i = 1; i < poly.length - 1; i++) idx.push(base, base + i, base + i + 1);
    }
  }
  const axis = (k) => pos.filter((_, i) => i % 3 === k);
  const min = [0, 1, 2].map((k) => Math.min(...axis(k)));
  const max = [0, 1, 2].map((k) => Math.max(...axis(k)));

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
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min, max },
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
  return Buffer.concat([header, chunk(json, 0x4e4f534a), chunk(bin, 0x004e4942)]);
}

mkdirSync("public/models", { recursive: true });
for (const [name, parts] of Object.entries(MODELS)) writeFileSync(`public/models/${name}.glb`, glb(parts));
