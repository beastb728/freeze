// Orbit viewer. Each photo is a depth-displaced mesh; the two cameras nearest the virtual
// viewpoint are each rotated about the subject and blended, so one fills the other's holes.
import * as THREE from '/vendor/three.module.js';

const $ = (id) => document.getElementById(id);
const [, , sid, capId] = location.pathname.split('/');
const base = `/data/${sid}/${capId}/`;

const EDGE = 0.15; // how far past the end cameras the orbit may go, in camera gaps
const LONG_SIDE_TAN = Math.tan(THREE.MathUtils.degToRad(31)); // phone main camera, about 62 degrees
// Used until the server's calibration arrives, or when it could not find a fit.
const DEFAULT_RANGE = 5; // farthest / nearest distance in the scene
const DEFAULT_PIVOT_SCALE = 1.1; // orbit centre sits a little behind the subject's surface
const DEFAULT_GAP = THREE.MathUtils.degToRad(15); // angle between neighbouring cameras
const ZOOM = 1.12; // crop slightly so rotated edges stay off screen
const GRID = [224, 168]; // mesh cells across and down each photo
const MAX_RENDER_SIDE = 1280; // cap on the drawing buffer's long side, in pixels
const SWAY_MS = 7000; // how long the opening sway runs before the viewer goes idle
const MAX_PITCH = THREE.MathUtils.degToRad(5);

const MESH_VERT = /* glsl */ `
  uniform sampler2D uDepth;
  uniform float uHasDepth;
  uniform float uPivot;
  uniform float uPivotScale;
  uniform float uYaw;
  uniform float uPitch;
  uniform float uRange;
  uniform vec2 uTan;
  uniform vec2 uViewTan;
  uniform vec2 uTexel;
  varying vec2 vUv;
  varying float vConf;

  // Depth maps store inverse depth: 1 is nearest. Distances run from 1 to uRange.
  float dist(float d) { return 1.0 / mix(1.0 / uRange, 1.0, d); }
  float depthAt(vec2 p) { return texture2D(uDepth, p).r; }

  void main() {
    vUv = uv;
    float d = uPivot;
    vConf = 1.0;
    if (uHasDepth > 0.5) {
      d = depthAt(uv);
      // A big jump to a neighbour means this vertex sits on a depth edge, where the mesh
      // stretches like a rubber sheet once rotated. Mark it low-confidence.
      float jump = max(
        max(abs(depthAt(uv + vec2(uTexel.x, 0.0)) - d), abs(depthAt(uv - vec2(uTexel.x, 0.0)) - d)),
        max(abs(depthAt(uv + vec2(0.0, uTexel.y)) - d), abs(depthAt(uv - vec2(0.0, uTexel.y)) - d)));
      vConf = 1.0 - smoothstep(0.015, 0.05, jump);
    }

    float z = dist(d);
    float zp = dist(uPivot) * uPivotScale;
    // Unproject, then rotate about the subject.
    vec3 q = vec3((uv * 2.0 - 1.0) * uTan * z, zp - z);
    float c = cos(uYaw), s = sin(uYaw);
    q = vec3(c * q.x + s * q.z, q.y, -s * q.x + c * q.z);
    c = cos(uPitch); s = sin(uPitch);
    q = vec3(q.x, c * q.y - s * q.z, s * q.y + c * q.z);
    float w = zp - q.z; // distance in front of the virtual camera

    const float near = 0.05, far = 40.0;
    gl_Position = vec4(q.xy / uViewTan, (w * (far + near) - 2.0 * far * near) / (far - near), w);
  }
`;

const MESH_FRAG = /* glsl */ `
  uniform sampler2D uPhoto;
  uniform sampler2D uDepth;
  uniform float uHasDepth;
  uniform float uYaw;
  uniform vec2 uTexel;
  varying vec2 vUv;
  varying float vConf;
  void main() {
    vec2 uv = vUv;
    if (uHasDepth > 0.5 && vConf < 0.99) {
      // On a stretched surface, paint with what lies just behind the edge rather than
      // smearing the foreground object across the gap. Off when the view is unrotated,
      // so a camera's own viewpoint shows its photo untouched.
      vec2 slope = vec2(
        texture2D(uDepth, vUv + vec2(uTexel.x, 0.0)).r - texture2D(uDepth, vUv - vec2(uTexel.x, 0.0)).r,
        texture2D(uDepth, vUv + vec2(0.0, uTexel.y)).r - texture2D(uDepth, vUv - vec2(0.0, uTexel.y)).r);
      float len = length(slope);
      if (len > 1e-4) {
        uv -= slope / len * uTexel * 1.6 * (1.0 - vConf) * clamp(abs(uYaw) / 0.03, 0.0, 1.0);
      }
    }
    // Alpha carries confidence to the blend pass; never zero, so the surface still counts.
    gl_FragColor = vec4(texture2D(uPhoto, uv).rgb, max(vConf, 0.03));
  }
`;

const BLEND_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BLEND_FRAG = /* glsl */ `
  uniform sampler2D uA;
  uniform sampler2D uB;
  uniform float uMix;
  varying vec2 vUv;
  void main() {
    vec4 a = texture2D(uA, vUv);
    vec4 b = texture2D(uB, vUv);
    float wa = (1.0 - uMix) * a.a * a.a;
    float wb = uMix * b.a * b.a;
    // Where the favoured camera has nothing, fall back to the other one entirely.
    if (wa + wb < 1e-5) { wa = a.a; wb = b.a; }
    float sum = wa + wb;
    vec3 colour = sum > 0.0 ? (a.rgb * wa + b.rgb * wb) / sum : vec3(0.027, 0.031, 0.043);
    gl_FragColor = vec4(colour, 1.0);
  }
`;

// ------------------------------------------------------------ state

let manifest = null;
let textures = []; // [camera][instant] -> { photo, depth }
let phi = 0; // viewpoint, in camera index units
let pitch = 0;
let velocity = 0;
let instant = 0;
let touched = false;
let version = 0; // bumped whenever something other than the viewpoint changes what is drawn
let drawnKey = '';
let playing = false;
let recording = null;

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.autoClear = false;
const camera = new THREE.Camera(); // unused: the shaders do their own projection
const targetA = new THREE.WebGLRenderTarget(4, 4);
const targetB = new THREE.WebGLRenderTarget(4, 4);

const meshMaterial = new THREE.ShaderMaterial({
  vertexShader: MESH_VERT,
  fragmentShader: MESH_FRAG,
  blending: THREE.NoBlending,
  side: THREE.DoubleSide,
  uniforms: {
    uPhoto: { value: null },
    uDepth: { value: null },
    uHasDepth: { value: 0 },
    uPivot: { value: 0.5 },
    uPivotScale: { value: 1 },
    uYaw: { value: 0 },
    uPitch: { value: 0 },
    uRange: { value: DEFAULT_RANGE },
    uTan: { value: new THREE.Vector2(1, 1) },
    uViewTan: { value: new THREE.Vector2(1, 1) },
    // One mesh cell: both ends of any triangle that spans a depth edge then see the jump.
    uTexel: { value: new THREE.Vector2(1 / GRID[0], 1 / GRID[1]) },
  },
});
const meshScene = new THREE.Scene();
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, GRID[0], GRID[1]), meshMaterial);
mesh.frustumCulled = false;
meshScene.add(mesh);

const blendMaterial = new THREE.ShaderMaterial({
  vertexShader: BLEND_VERT,
  fragmentShader: BLEND_FRAG,
  depthTest: false,
  uniforms: { uA: { value: targetA.texture }, uB: { value: targetB.texture }, uMix: { value: 0 } },
});
const blendScene = new THREE.Scene();
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blendMaterial);
quad.frustumCulled = false;
blendScene.add(quad);

// ------------------------------------------------------------ loading

const loader = new THREE.TextureLoader();
function loadTexture(file) {
  return new Promise((resolve, reject) => {
    loader.load(
      base + file,
      (texture) => {
        texture.generateMipmaps = false;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        version++;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

async function fetchManifest() {
  const res = await fetch(`/api/s/${sid}/c/${capId}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('missing');
  return res.json();
}

/** Loads any depth maps that have appeared since the last look. */
async function loadNewDepth() {
  const jobs = [];
  manifest.cameras.forEach((cam, c) =>
    cam.frames.forEach((frame, k) => {
      const slot = textures[c][k];
      if (frame.depth && !slot.depth && !slot.loadingDepth) {
        slot.loadingDepth = true;
        jobs.push(loadTexture(frame.depth).then((t) => (slot.depth = t)).catch(() => (slot.loadingDepth = false)));
      }
    }),
  );
  await Promise.all(jobs);
  renderInfo();
}

function renderInfo() {
  const total = manifest.cameras.length * manifest.offsets.length;
  const ready = textures.flat().filter((t) => t.depth).length;
  const cameras = `${manifest.cameras.length} camera${manifest.cameras.length > 1 ? 's' : ''}`;
  let state = '3D';
  if (manifest.status === 'processing') state = `adding depth ${ready}/${total}`;
  else if (manifest.status === 'photos-only') state = 'photos only';
  const sync = manifest.cameras.length > 1 ? ` · in sync to ${Math.max(1, manifest.syncSpreadMs)} ms` : '';
  $('info').textContent = `${cameras} · ${state}${sync}`;
  $('info').hidden = false;
}

async function poll() {
  while (manifest.status === 'processing') {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const next = await fetchManifest();
      next.cameras.forEach((cam, c) => cam.frames.forEach((f, k) => Object.assign(manifest.cameras[c].frames[k], f)));
      manifest.status = next.status;
      manifest.calib = next.calib;
      version++;
      await loadNewDepth();
    } catch {
      /* keep trying */
    }
  }
}

async function init() {
  try {
    manifest = await fetchManifest();
  } catch {
    $('message').textContent = 'This scene could not be found.';
    return;
  }
  const cams = manifest.cameras.length;
  const instants = manifest.offsets.length;
  textures = manifest.cameras.map((cam) => cam.frames.map(() => ({ photo: null, depth: null })));

  // First instant first, so something is on screen quickly; the rest stream in behind it.
  const loadInstant = (k) =>
    Promise.all(manifest.cameras.map((cam, c) => loadTexture(cam.frames[k].img).then((t) => (textures[c][k].photo = t))));
  await loadInstant(0);
  $('message').hidden = true;
  $('bar').hidden = false;
  $('dragtip').hidden = false;
  phi = (cams - 1) / 2;
  // ?view=1.5 opens the scene at a fixed viewpoint (halfway between cameras 2 and 3).
  const pinned = new URLSearchParams(location.search).get('view');
  if (pinned !== null && Number.isFinite(Number(pinned))) {
    phi = Number(pinned);
    touched = true;
  }
  resize();
  requestAnimationFrame(frame);

  if (instants > 1) {
    $('timeline').hidden = false;
    $('time').max = instants - 1;
    for (let k = 1; k < instants; k++) await loadInstant(k);
  }
  await loadNewDepth();
  poll();
}

// ------------------------------------------------------------ rendering

function resize() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // Three full-screen passes per frame: keep the buffer modest so integrated graphics cope.
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5, MAX_RENDER_SIDE / Math.max(w, h));
  renderer.setPixelRatio(ratio);
  renderer.setSize(w, h, false);
  version++;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  targetA.setSize(size.x, size.y);
  targetB.setSize(size.x, size.y);
}
window.addEventListener('resize', resize);

function sourceTan(cam) {
  return cam.w >= cam.h
    ? [LONG_SIDE_TAN, (LONG_SIDE_TAN * cam.h) / cam.w]
    : [(LONG_SIDE_TAN * cam.w) / cam.h, LONG_SIDE_TAN];
}

function drawCamera(c, yaw, target) {
  const cam = manifest.cameras[c];
  // Fall back to the first instant while later ones are still loading.
  const slot = textures[c][instant].photo ? textures[c][instant] : textures[c][0];
  const frameInfo = cam.frames[slot === textures[c][0] ? 0 : instant];
  const u = meshMaterial.uniforms;
  const [tx, ty] = sourceTan(cam);

  // Fit the first camera's image inside the canvas, then crop by ZOOM.
  const [fx, fy] = sourceTan(manifest.cameras[0]);
  const aspect = canvas.clientWidth / canvas.clientHeight;
  const viewTan = aspect > fx / fy ? [fy * aspect, fy] : [fx, fx / aspect];

  u.uPhoto.value = slot.photo;
  u.uDepth.value = slot.depth;
  u.uHasDepth.value = slot.depth ? 1 : 0;
  u.uPivot.value = slot.depth ? frameInfo.pivot : 0.5;
  u.uPivotScale.value = slot.depth ? (manifest.calib?.pivotScales[c] ?? DEFAULT_PIVOT_SCALE) : 1;
  u.uRange.value = manifest.calib?.ranges[c] ?? DEFAULT_RANGE;
  u.uYaw.value = yaw;
  u.uPitch.value = pitch;
  u.uTan.value.set(tx, ty);
  u.uViewTan.value.set(viewTan[0] / ZOOM, viewTan[1] / ZOOM);

  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 0);
  renderer.clear();
  renderer.render(meshScene, camera);
}

function draw() {
  const cams = manifest.cameras.length;
  const i = Math.max(0, Math.min(cams - 2, Math.floor(phi)));
  const f = phi - i; // 0 at camera i, 1 at camera i + 1; outside that range past the ends
  const gap = manifest.calib?.gaps[i] ?? DEFAULT_GAP;
  // Moving the viewpoint right swings the scene the other way about the subject.
  drawCamera(i, -f * gap, targetA);
  if (cams > 1) drawCamera(i + 1, (1 - f) * gap, targetB);
  // Hand over in the middle of the gap; near a camera, show that camera alone.
  const t = Math.max(0, Math.min(1, (f - 0.15) / 0.7));
  blendMaterial.uniforms.uB.value = cams > 1 ? targetB.texture : targetA.texture;
  blendMaterial.uniforms.uMix.value = cams > 1 ? t * t * (3 - 2 * t) : 0;
  renderer.setRenderTarget(null);
  renderer.render(blendScene, camera);
}

const phiMin = () => -EDGE;
const phiMax = () => manifest.cameras.length - 1 + EDGE;
let lastTime = 0;
let swayStart = null;
let playClock = 0;

function frame(time) {
  const dt = Math.min(0.05, (time - lastTime) / 1000 || 0);
  lastTime = time;

  if (recording) {
    stepRecording(time);
  } else if (!touched) {
    // Sway gently for a few seconds so it is obviously not a flat photo, then rest.
    swayStart ??= time;
    const mid = (manifest.cameras.length - 1) / 2;
    const fade = Math.max(0, 1 - (time - swayStart) / SWAY_MS);
    phi = mid + Math.sin((time - swayStart) / 1300) * Math.min(0.9, mid + EDGE * 0.8) * fade;
    if (fade === 0) touched = true;
  } else if (!dragging && Math.abs(velocity) > 0.001) {
    phi += velocity * dt;
    velocity *= Math.exp(-dt * 5);
  }
  phi = Math.max(phiMin(), Math.min(phiMax(), phi));

  if (playing && !recording) {
    playClock += dt;
    setInstant(Math.floor(playClock / 0.12) % manifest.offsets.length);
  }

  // Only spend GPU time when the picture would actually change.
  const key = `${phi.toFixed(4)}|${pitch.toFixed(4)}|${instant}|${version}`;
  if (key !== drawnKey || recording) {
    drawnKey = key;
    draw();
  }
  requestAnimationFrame(frame);
}

function setInstant(k) {
  instant = k;
  $('time').value = k;
}

// ------------------------------------------------------------ interaction

let dragging = false;
let lastX = 0;
let lastY = 0;
let lastMove = 0;

canvas.addEventListener('pointerdown', (event) => {
  dragging = true;
  touched = true;
  velocity = 0;
  lastX = event.clientX;
  lastY = event.clientY;
  lastMove = performance.now();
  canvas.setPointerCapture(event.pointerId);
  $('dragtip').style.opacity = 0;
});

canvas.addEventListener('pointermove', (event) => {
  if (!dragging) return;
  const span = phiMax() - phiMin();
  // A drag across the screen covers the whole arc. Dragging right moves the scene right.
  const dPhi = (-(event.clientX - lastX) / canvas.clientWidth) * span * 1.1;
  const now = performance.now();
  phi += dPhi;
  velocity = dPhi / Math.max(0.008, (now - lastMove) / 1000);
  pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch + ((event.clientY - lastY) / canvas.clientHeight) * 0.35));
  lastX = event.clientX;
  lastY = event.clientY;
  lastMove = now;
});

for (const type of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(type, () => {
    dragging = false;
    if (performance.now() - lastMove > 80) velocity = 0;
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  touched = true;
  velocity = event.key === 'ArrowLeft' ? -1.6 : 1.6;
});

$('time').addEventListener('input', (event) => {
  playing = false;
  $('play').textContent = 'Play';
  setInstant(Number(event.target.value));
});

$('play').addEventListener('click', () => {
  playing = !playing;
  playClock = instant * 0.12;
  $('play').textContent = playing ? 'Pause' : 'Play';
});

$('share').addEventListener('click', async () => {
  const url = location.href;
  try {
    if (navigator.share) await navigator.share({ title: 'Freeze scene', url });
    else {
      await navigator.clipboard.writeText(url);
      $('share').textContent = 'Link copied';
      setTimeout(() => ($('share').textContent = 'Share'), 1600);
    }
  } catch {
    /* share sheet dismissed */
  }
});

// ------------------------------------------------------------ video export

const RECORD_MS = 4000;

$('record').addEventListener('click', () => {
  if (recording || !canvas.captureStream || !window.MediaRecorder) return;
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return;
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  recorder.onstop = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob(chunks, { type }));
    link.download = `freeze-${capId}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    $('record').textContent = 'Save video';
  };
  recording = { recorder, start: performance.now() };
  touched = true;
  $('record').textContent = 'Recording…';
  recorder.start();
});

/** Sweeps the orbit end to end and back; in a time slice, time runs forward then back. */
function stepRecording(time) {
  const p = (time - recording.start) / RECORD_MS;
  if (p >= 1) {
    recording.recorder.stop();
    recording = null;
    return;
  }
  const sweep = 0.5 - 0.5 * Math.cos(p * Math.PI * 2); // 0 -> 1 -> 0
  phi = phiMin() + (phiMax() - phiMin()) * sweep;
  const last = manifest.offsets.length - 1;
  if (last > 0) setInstant(Math.round(last * sweep));
}

init();
