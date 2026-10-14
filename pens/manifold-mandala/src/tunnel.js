import {
  Obj,
  Renderer,
  Program,
  Mesh,
  Uniform,
  Camera,
  Triangle,
  Geometry,
  GeometryAttribute,
  Framebuffer,
  Vec2,
  Vec3,
} from "wtc-gl";

import ringVert from "./shaders/ring.vert.js";
import ringFrag from "./shaders/ring.frag.js";
import postFrag from "./shaders/post.frag.js";
import { SHAPES, buildModule, rand, randInt, pick, chance } from "./shapes.js";

const TAU = Math.PI * 2;

// --- worlds (palettes). New rings adopt the current world, so a change
// sweeps through the tunnel from the far end.
const WORLDS = [
  {
    // the reference: yellow core, green body, pink lattice
    inner: [0.98, 0.9, 0.32],
    outer: [0.6, 0.78, 0.32],
    accent: [0.93, 0.4, 0.47],
    accent2: [0.86, 0.6, 0.2],
    bg: [[1.0, 0.97, 0.88], [0.98, 0.8, 0.7], [0.82, 0.93, 0.9]],
  },
  {
    inner: [0.4, 0.88, 0.86],
    outer: [0.22, 0.46, 0.78],
    accent: [1.0, 0.55, 0.28],
    accent2: [0.96, 0.86, 0.52],
    bg: [[0.93, 0.97, 1.0], [0.8, 0.88, 0.98], [0.99, 0.9, 0.84]],
  },
  {
    inner: [0.8, 0.64, 0.96],
    outer: [0.46, 0.36, 0.76],
    accent: [0.45, 0.9, 0.7],
    accent2: [0.98, 0.76, 0.86],
    bg: [[0.97, 0.94, 1.0], [0.92, 0.84, 0.98], [0.87, 0.97, 0.93]],
  },
  {
    inner: [0.99, 0.6, 0.32],
    outer: [0.82, 0.22, 0.28],
    accent: [0.32, 0.34, 0.5],
    accent2: [0.99, 0.86, 0.56],
    bg: [[1.0, 0.95, 0.9], [0.99, 0.82, 0.74], [0.95, 0.9, 0.8]],
  },
];
let worldIndex = 0;
let world = WORLDS[0];

// --- renderer
const dpr = Math.min(window.devicePixelRatio, 2);
const d = new Vec2(window.innerWidth, window.innerHeight);

const renderer = new Renderer({ dpr, width: d.width, height: d.height });
const { gl } = renderer;
gl.getExtension("EXT_color_buffer_float");
document.body.appendChild(gl.canvas);

const camera = new Camera({ fov: 70, near: 0.3, far: 600, aspect: d.width / d.height });

// --- uniforms (keys are the GLSL names)
const uniforms = {
  u_time: new Uniform({ name: "time", value: 0, kind: "float" }),
  u_roll: new Uniform({ name: "roll", value: 0, kind: "float" }),
  u_swirl: new Uniform({ name: "swirl", value: 0.012, kind: "float" }),
  u_resolution: new Uniform({ name: "resolution", value: d.scaleNew(dpr).array, kind: "float_vec2" }),
  u_dpr: new Uniform({ name: "dpr", value: dpr, kind: "float" }),
  u_fog: new Uniform({ name: "fog", value: 105, kind: "float" }),
  u_fogStart: new Uniform({ name: "fogStart", value: 0, kind: "float" }),
  u_tA: new Uniform({ name: "tA", value: [0, 0, 0, 1], kind: "float_vec4" }),
  u_tB: new Uniform({ name: "tB", value: [1, 0, 0, 0], kind: "float_vec4" }),
  u_tC: new Uniform({ name: "tC", value: [0, 0, 0, 0], kind: "float_vec4" }),
  u_tD: new Uniform({ name: "tD", value: [0, 0, 0, 0], kind: "float_vec4" }),
  u_tCol: new Uniform({ name: "tCol", value: [1, 1, 1], kind: "float_vec3" }),
  u_bgA: new Uniform({ name: "bgA", value: [...world.bg[0]], kind: "float_vec3" }),
  u_bgB: new Uniform({ name: "bgB", value: [...world.bg[1]], kind: "float_vec3" }),
  u_bgC: new Uniform({ name: "bgC", value: [...world.bg[2]], kind: "float_vec3" }),
  b_scene: new Uniform({ name: "scene", value: null, kind: "texture" }),
};

const ringProgram = new Program(gl, {
  vertex: ringVert,
  fragment: ringFrag,
  uniforms,
  cullFace: null, // mirrored modules flip winding
});

// --- rings
const RING_COUNT = 44;
const SPACING = 4.2;
const DEPTH = RING_COUNT * SPACING;
const SPEED = 2.2; // units per second toward the camera

const scene = new Obj();
const rings = [];

const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const jitter = (c, j) => c.map((v) => Math.min(1, Math.max(0, v + rand(-j, j))));

function configureRing(ring) {
  const name = pick(Object.keys(SHAPES));
  const shape = SHAPES[name];

  // radius bands: mostly mid, a few tight cores and wide outer lattices
  const R = pick([rand(4, 9), rand(9, 18), rand(9, 18), rand(16, 30), rand(26, 40)]);
  const wTarget = rand(1.0, 2.6) * (R > 25 ? 1.4 : 1);
  let N = Math.max(8, Math.round((TAU * R) / wTarget / 4) * 4);
  const w = (TAU * R) / N;

  const B = buildModule(name, w);

  const t01 = Math.min(1, Math.max(0, (R - 4) / 30));
  let col = mix(world.inner, world.outer, t01);
  // pink lattice lives on the outside; gold accents are occasional
  if (R > 24 && (shape.accent || chance(0.5))) col = world.accent;
  else if (shape.accent ? chance(0.4) : chance(0.12)) col = world.accent2;
  col = jitter(col, 0.04);

  const twistTurns = chance(0.25) ? pick([1, 2, 3, -1, -2]) : 0;
  const waveF = pick([0, 2, 3, 4, 6, 8]);

  ring.cfg = {
    name,
    R,
    N,
    spin: rand(0, TAU),
    spinSpeed: rand(0.02, 0.12) * (ring.index % 2 ? 1 : -1),
    tA: [R, 0, 0, 1],
    tB: [N, waveF ? rand(0.02, 0.1) : 0, waveF, rand(-1, 1) * shape.tilt],
    tC: [twistTurns, chance(0.5) ? rand(0.3, 2) : 0, pick([2, 3, 4, 6]), chance(0.5) ? 1 : 0],
    tD: [chance(0.6) ? rand(0.05, 0.25) : 0, rand(0, TAU), pick([1, 2, 3, 4, 6]), rand(0.6, 1.6)],
    col,
  };

  // geometry: module verts + per-instance slot/random
  const inst = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) inst.set([i, Math.random()], i * 2);
  const geometry = new Geometry(gl, {
    position: new GeometryAttribute({ size: 3, data: new Float32Array(B.positions) }),
    normal: new GeometryAttribute({ size: 3, data: new Float32Array(B.normals) }),
    shade: new GeometryAttribute({ size: 1, data: new Float32Array(B.shades) }),
    inst: new GeometryAttribute({ size: 2, data: inst, instanced: 1 }),
  });

  if (ring.mesh) {
    disposeGeometry(ring.mesh.geometry);
    ring.mesh.geometry = geometry;
  } else {
    ring.mesh = new Mesh(gl, { geometry, program: ringProgram, frustumCulled: false });
    // per-ring uniforms are pushed into the shared program right before draw
    ring.mesh.addBeforeRender(() => {
      const c = ring.cfg;
      uniforms.u_tA.value = c.tA;
      uniforms.u_tB.value = c.tB;
      uniforms.u_tC.value = c.tC;
      uniforms.u_tD.value = c.tD;
      uniforms.u_tCol.value = c.col;
    });
    ring.mesh.setParent(scene);
  }
}

function disposeGeometry(geometry) {
  for (const key in geometry.attributes) {
    const buf = geometry.attributes[key].buffer;
    if (buf) gl.deleteBuffer(buf);
  }
}

for (let i = 0; i < RING_COUNT; i++) {
  const ring = { index: i, z: -(i + 1) * SPACING };
  configureRing(ring);
  rings.push(ring);
}

// --- post
const sceneFBO = new Framebuffer(gl, {
  name: "scene",
  dpr,
  width: d.width,
  height: d.height,
  texdepth: Framebuffer.TEXTYPE_FLOAT,
  minFilter: gl.NEAREST,
  magFilter: gl.NEAREST,
});

const postMesh = new Mesh(gl, {
  geometry: new Triangle(gl),
  program: new Program(gl, {
    vertex: `#version 300 es
in vec3 position;
void main() { gl_Position = vec4(position, 1.0); }`,
    fragment: postFrag,
    uniforms,
    depthTest: false,
  }),
});

// --- resize
function resize() {
  d.reset(window.innerWidth, window.innerHeight);
  renderer.dimensions = d;
  uniforms.u_resolution.value = d.scaleNew(dpr).array;
  camera.perspective({ aspect: d.width / d.height });
  sceneFBO.resize(d.width, d.height);
}
window.addEventListener("resize", resize);

// --- interaction
const mouse = new Vec2(0, 0);
let look = new Vec2(0, 0);
window.addEventListener("pointermove", (e) => {
  mouse.reset((e.clientX / d.width) * 2 - 1, (e.clientY / d.height) * 2 - 1);
});

let playing = true;
function nextWorld() {
  worldIndex = (worldIndex + 1) % WORLDS.length;
  world = WORLDS[worldIndex];
}
window.addEventListener("click", nextWorld);
window.addEventListener("keydown", (e) => {
  if (e.code === "Space") playing = !playing;
  if (e.code === "KeyR") rings.forEach(configureRing);
});
setInterval(() => playing && nextWorld(), 40000);

// --- loop
let last = performance.now();
let time = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!playing) return;
  time += dt;

  uniforms.u_time.value = time;
  uniforms.u_roll.value = time * 0.015;

  for (const ring of rings) {
    ring.z += SPEED * dt;
    if (ring.z > 2) {
      ring.z -= DEPTH;
      configureRing(ring);
    }
    ring.cfg.spin += ring.cfg.spinSpeed * dt;
    ring.cfg.tA = [ring.cfg.R, ring.z, ring.cfg.spin, 1];
  }

  // ease the sky toward the current world
  const k = 1 - Math.exp(-dt * 0.25);
  ["u_bgA", "u_bgB", "u_bgC"].forEach((key, i) => {
    uniforms[key].value = mix(uniforms[key].value, world.bg[i], k);
  });

  // gentle parallax, the vanishing point drifts with the pointer
  look = Vec2.lerp(look, mouse, 1 - Math.exp(-dt * 2));
  camera.lookAt(new Vec3(look.x * 25, -look.y * 15, -100));

  gl.clearColor(0, 0, 0, 0);
  sceneFBO.render(renderer, { scene, camera });
  uniforms.b_scene.value = sceneFBO.read.texture;
  renderer.render({ scene: postMesh, clear: false });
}
requestAnimationFrame(frame);
