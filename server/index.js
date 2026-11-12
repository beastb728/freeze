// Freeze server: sessions, seats, shared clock, frame uploads, capture manifests.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { DepthQueue } from './depth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const CERT_DIR = path.join(ROOT, '.cert');
const HTTP_PORT = Number(process.env.PORT || 4747);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 4748);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

const COUNTDOWN_MS = 3000;
const UPLOAD_GRACE_MS = 10000;
const MAX_FRAME_LATENESS_MS = 120;
const MAX_FRAME_BYTES = 10 * 1024 * 1024;
const MODES = {
  still: [0],
  burst: [0, 120, 240, 360, 480, 600],
};

const SID_RE = /^[A-Z2-9]{5}$/;
const CAP_RE = /^[a-z0-9]{4,16}$/;
const FILE_RE = /^[a-z0-9_]+\.(jpg|png|json)$/;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Server clock in milliseconds; monotonic, so it never jumps mid-session. */
const now = () => performance.timeOrigin + performance.now();

const sessions = new Map(); // id -> session
const captures = new Map(); // `${sid}/${capId}` -> capture
const depth = new DepthQueue(ROOT);

// ---------------------------------------------------------------- sessions

function newSessionId() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) {
    let id = '';
    for (const b of crypto.randomBytes(5)) id += alphabet[b % alphabet.length];
    if (!sessions.has(id)) return id;
  }
}

function createSession() {
  const session = {
    id: newSessionId(),
    hostKey: crypto.randomBytes(12).toString('hex'),
    clients: new Map(), // clientId -> client
    order: [], // clientIds of camera clients, left to right
    captureIds: [],
    armed: null, // capture currently counting down or uploading
    createdAt: Date.now(),
  };
  sessions.set(session.id, session);
  return session;
}

function publicState(session) {
  const seatOf = new Map(session.order.map((id, i) => [id, i + 1]));
  return {
    type: 'state',
    clients: [...session.clients.values()].map((c) => ({
      id: c.id,
      name: c.name,
      isHost: c.isHost,
      hasCamera: c.hasCamera,
      seat: seatOf.get(c.id) || null,
      rtt: c.rtt,
    })),
    busy: Boolean(session.armed),
    captures: session.captureIds.map((id) => {
      const cap = captures.get(`${session.id}/${id}`);
      return {
        id,
        status: cap.status,
        mode: cap.mode,
        cameras: cap.manifest ? cap.manifest.cameras.length : cap.seats.length,
        url: `/v/${session.id}/${id}`,
      };
    }),
  };
}

function send(client, msg) {
  if (client.ws && client.ws.readyState === 1) client.ws.send(JSON.stringify(msg));
}

function broadcast(session, msg) {
  for (const c of session.clients.values()) send(c, msg);
}

function broadcastState(session) {
  broadcast(session, publicState(session));
}

function onSocket(ws, session) {
  let client = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'ping') {
      // Clock sync: echo the client's send time alongside ours.
      ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, ts: now() }));
      if (client && Number.isFinite(msg.rtt)) client.rtt = Math.round(msg.rtt);
      return;
    }

    if (msg.type === 'hello') {
      const id = String(msg.clientId || '').slice(0, 40);
      if (!id) return ws.close();
      const previous = session.clients.get(id);
      if (previous && previous.ws !== ws) previous.ws.close();
      client = {
        id,
        ws,
        name: String(msg.name || 'Phone').slice(0, 24),
        isHost: msg.hostKey === session.hostKey,
        hasCamera: Boolean(msg.hasCamera),
        rtt: previous ? previous.rtt : null,
      };
      session.clients.set(id, client);
      const seated = session.order.includes(id);
      if (client.hasCamera && !seated) session.order.push(id);
      if (!client.hasCamera && seated) session.order = session.order.filter((x) => x !== id);
      send(client, { type: 'welcome', id, isHost: client.isHost, modes: Object.keys(MODES) });
      broadcastState(session);
      return;
    }

    if (!client) return;

    if (msg.type === 'move') {
      // Shift this camera one place left or right in the line-up.
      const i = session.order.indexOf(client.id);
      const j = i + (msg.dir < 0 ? -1 : 1);
      if (i < 0 || j < 0 || j >= session.order.length || session.armed) return;
      [session.order[i], session.order[j]] = [session.order[j], session.order[i]];
      broadcastState(session);
      return;
    }

    if (msg.type === 'fire') {
      if (!client.isHost) return send(client, { type: 'error', message: 'Only the host can freeze.' });
      if (session.armed) return;
      if (!session.order.length) {
        return send(client, { type: 'error', message: 'No cameras have joined yet.' });
      }
      arm(session, MODES[msg.mode] ? msg.mode : 'still');
    }
  });

  ws.on('close', () => {
    if (!client || session.clients.get(client.id) !== client) return;
    session.clients.delete(client.id);
    session.order = session.order.filter((x) => x !== client.id);
    broadcastState(session);
  });
}

// ---------------------------------------------------------------- captures

function arm(session, mode) {
  const offsets = MODES[mode];
  const cap = {
    id: Date.now().toString(36).slice(-6) + crypto.randomBytes(1).toString('hex'),
    sessionId: session.id,
    mode,
    offsets,
    T: now() + COUNTDOWN_MS,
    // Snapshot of who is shooting and from which seat.
    seats: session.order.map((clientId, i) => ({
      clientId,
      seat: i + 1,
      name: session.clients.get(clientId).name,
      frames: new Map(), // k -> { file, dt, w, h }
    })),
    status: 'capturing',
    manifest: null,
  };
  cap.dir = path.join(DATA_DIR, session.id, cap.id);
  fs.mkdirSync(cap.dir, { recursive: true });
  captures.set(`${session.id}/${cap.id}`, cap);
  session.captureIds.push(cap.id);
  session.armed = cap;

  const seatOf = new Map(cap.seats.map((s) => [s.clientId, s.seat]));
  for (const c of session.clients.values()) {
    send(c, { type: 'arm', capId: cap.id, T: cap.T, offsets, mode, seat: seatOf.get(c.id) || null });
  }
  broadcastState(session);

  const deadline = COUNTDOWN_MS + offsets[offsets.length - 1] + UPLOAD_GRACE_MS;
  cap.timer = setTimeout(() => finalize(session, cap), deadline);
}

function receivedAll(cap) {
  return cap.seats.every((s) => s.frames.size === cap.offsets.length);
}

async function finalize(session, cap) {
  if (cap.status !== 'capturing') return;
  clearTimeout(cap.timer);
  session.armed = null;

  // A camera only counts if every one of its instants arrived.
  const arrived = cap.seats.filter((s) => s.frames.size === cap.offsets.length);
  if (!arrived.length) {
    cap.status = 'failed';
    broadcastState(session);
    return;
  }
  // A phone whose camera stalled (tab in the background, say) sends a frame from the wrong
  // moment. Leave it out rather than freeze two different instants into one scene.
  const lateness = (s) => Math.max(...[...s.frames.values()].map((f) => Math.abs(f.dt)));
  const onTime = arrived.filter((s) => lateness(s) <= MAX_FRAME_LATENESS_MS);
  const complete = onTime.length ? onTime : arrived;

  // Per instant, how far apart in time the cameras' chosen frames were; report the worst.
  const spreads = cap.offsets.map((_, k) => {
    const dts = complete.map((s) => s.frames.get(k).dt);
    return Math.max(...dts) - Math.min(...dts);
  });
  cap.manifest = {
    id: cap.id,
    session: cap.sessionId,
    mode: cap.mode,
    createdAt: new Date().toISOString(),
    offsets: cap.offsets,
    status: 'processing',
    calib: null, // filled in by the depth step: camera gaps, depth ranges, pivot scales
    syncSpreadMs: Math.round(Math.max(...spreads)),
    dropped: cap.seats.filter((s) => !complete.includes(s)).map((s) => s.name),
    cameras: complete.map((s) => ({
      seat: s.seat,
      name: s.name,
      w: s.frames.get(0).w,
      h: s.frames.get(0).h,
      frames: cap.offsets.map((_, k) => {
        const f = s.frames.get(k);
        return { img: f.file, depth: null, pivot: 0.5, dt: Math.round(f.dt * 10) / 10 };
      }),
    })),
  };
  cap.status = 'processing';
  await saveManifest(cap);
  broadcastState(session);

  try {
    await depth.run(
      { dir: cap.dir, cameras: cap.manifest.cameras.map((c) => c.frames.map((f) => f.img)) },
      (msg) => {
        if (msg.type === 'calib') {
          cap.manifest.calib = msg.calib;
          return;
        }
        const frame = cap.manifest.cameras[msg.cam].frames[msg.k];
        frame.depth = msg.depth;
        frame.pivot = msg.pivot;
      },
    );
    cap.manifest.status = 'done';
  } catch (err) {
    console.warn(`[depth] ${cap.id}: ${err.message}`);
    cap.manifest.status = 'photos-only';
    cap.manifest.note = 'Depth step unavailable; showing a cross-fade between cameras.';
  }
  cap.status = cap.manifest.status;
  await saveManifest(cap);
  broadcastState(session);
}

async function saveManifest(cap) {
  const file = path.join(cap.dir, 'manifest.json');
  await fsp.writeFile(file + '.tmp', JSON.stringify(cap.manifest, null, 2));
  await fsp.rename(file + '.tmp', file);
}

async function handleFrameUpload(req, res, session, capId, query) {
  const cap = captures.get(`${session.id}/${capId}`);
  if (!cap || cap.status !== 'capturing') return json(res, 409, { error: 'Capture is closed.' });
  const seat = cap.seats.find((s) => s.clientId === query.get('client'));
  const k = Number(query.get('k'));
  if (!seat || !Number.isInteger(k) || k < 0 || k >= cap.offsets.length) {
    return json(res, 400, { error: 'Unknown camera or instant.' });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FRAME_BYTES) return json(res, 413, { error: 'Frame too large.' });
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  // JPEG files start FF D8.
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) {
    return json(res, 400, { error: 'Expected a JPEG.' });
  }

  const file = `c${seat.seat}_t${k}.jpg`;
  await fsp.writeFile(path.join(cap.dir, file), body);
  seat.frames.set(k, {
    file,
    dt: Number(query.get('dt')) || 0,
    w: Number(query.get('w')) || 0,
    h: Number(query.get('h')) || 0,
  });
  json(res, 200, { ok: true });
  if (receivedAll(cap)) finalize(session, cap);
}

// ---------------------------------------------------------------- http

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function sendFile(res, file, cache = 'no-cache') {
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': cache,
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

let lanIp = '127.0.0.1';
let httpsEnabled = false;

/** The address phones should use to reach this server. */
function joinOrigin(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.headers.host || `localhost:${HTTP_PORT}`;
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host);
  if (isLocal && httpsEnabled) return `https://${lanIp}:${HTTPS_PORT}`;
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const seg = p.split('/').filter(Boolean);

  if (req.method === 'POST' && p === '/api/sessions') {
    const s = createSession();
    return json(res, 200, { id: s.id, hostKey: s.hostKey });
  }

  if (seg[0] === 'api' && seg[1] === 's' && SID_RE.test(seg[2] || '')) {
    const session = sessions.get(seg[2]);

    // Manifests are served from disk too, so result links outlive the session.
    if (req.method === 'GET' && seg[3] === 'c' && CAP_RE.test(seg[4] || '') && seg.length === 5) {
      const cap = captures.get(`${seg[2]}/${seg[4]}`);
      if (cap && cap.manifest) return json(res, 200, cap.manifest);
      return sendFile(res, path.join(DATA_DIR, seg[2], seg[4], 'manifest.json'), 'no-store');
    }

    if (!session) return json(res, 404, { error: 'This session has ended.' });

    if (req.method === 'GET' && seg.length === 3) {
      return json(res, 200, { id: session.id, joinUrl: `${joinOrigin(req)}/s/${session.id}` });
    }
    if (req.method === 'GET' && seg[3] === 'qr.svg') {
      const svg = await QRCode.toString(`${joinOrigin(req)}/s/${session.id}`, {
        type: 'svg',
        margin: 1,
        color: { dark: '#0b0d12', light: '#ffffff' },
      });
      res.writeHead(200, { 'content-type': MIME['.svg'], 'cache-control': 'no-store' });
      return res.end(svg);
    }
    if (req.method === 'POST' && seg[3] === 'c' && CAP_RE.test(seg[4] || '') && seg[5] === 'frame') {
      return handleFrameUpload(req, res, session, seg[4], url.searchParams);
    }
    return json(res, 404, { error: 'Not found.' });
  }

  if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' });

  if (p === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  if (seg[0] === 's' && seg.length === 2) return sendFile(res, path.join(PUBLIC_DIR, 'session.html'));
  if (seg[0] === 'v' && seg.length === 3) return sendFile(res, path.join(PUBLIC_DIR, 'viewer.html'));

  if (seg[0] === 'vendor' && /^three\.(module|core)\.js$/.test(seg[1] || '') && seg.length === 2) {
    return sendFile(res, path.join(ROOT, 'node_modules/three/build', seg[1]), 'public, max-age=86400');
  }

  if (seg[0] === 'data' && seg.length === 4) {
    if (SID_RE.test(seg[1]) && CAP_RE.test(seg[2]) && FILE_RE.test(seg[3])) {
      return sendFile(res, path.join(DATA_DIR, seg[1], seg[2], seg[3]), 'public, max-age=3600');
    }
  }

  if (seg.length === 1 && /^[a-z0-9.-]+$/.test(seg[0]) && MIME[path.extname(seg[0])]) {
    return sendFile(res, path.join(PUBLIC_DIR, seg[0]));
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
}

function listener(req, res) {
  handle(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error.' });
    else res.end();
  });
}

// ---------------------------------------------------------------- startup

function findLanIp() {
  // Ask the OS which interface it would route outward from. No packet is sent.
  return new Promise((resolve) => {
    const fallback = () => {
      const all = Object.values(os.networkInterfaces()).flat();
      const hit = all.find((i) => i && i.family === 'IPv4' && !i.internal);
      resolve(hit ? hit.address : '127.0.0.1');
    };
    const sock = dgram.createSocket('udp4');
    sock.once('error', () => {
      sock.close();
      fallback();
    });
    sock.connect(53, '8.8.8.8', () => {
      const { address } = sock.address();
      sock.close();
      resolve(address);
    });
  });
}

/** Phones only expose the camera on secure pages, so the LAN needs a certificate. */
function loadOrCreateCert(ip) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const ipFile = path.join(CERT_DIR, 'ip.txt');
  try {
    const cached = fs.existsSync(ipFile) && fs.readFileSync(ipFile, 'utf8') === ip;
    if (!cached) {
      fs.mkdirSync(CERT_DIR, { recursive: true });
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
          '-keyout', keyFile, '-out', certFile,
          '-subj', '/CN=Freeze local',
          '-addext', `subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost`,
        ],
        { stdio: 'ignore' },
      );
      fs.writeFileSync(ipFile, ip);
    }
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  } catch (err) {
    console.warn(`Could not create a certificate (${err.message}). Phones will need a tunnel.`);
    return null;
  }
}

function attachSockets(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const session = sessions.get(url.searchParams.get('s') || '');
    if (url.pathname !== '/ws' || !session) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, session));
  });
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  lanIp = await findLanIp();

  const plain = http.createServer(listener);
  attachSockets(plain);
  await new Promise((resolve) => plain.listen(HTTP_PORT, resolve));

  const tls = PUBLIC_URL ? null : loadOrCreateCert(lanIp);
  if (tls) {
    const secure = https.createServer(tls, listener);
    attachSockets(secure);
    await new Promise((resolve) => secure.listen(HTTPS_PORT, resolve));
    httpsEnabled = true;
  }

  console.log('\n  Freeze is running\n');
  console.log(`  On this laptop   http://localhost:${HTTP_PORT}`);
  if (PUBLIC_URL) console.log(`  Phones join at   ${PUBLIC_URL}`);
  else if (httpsEnabled) console.log(`  Phones join at   https://${lanIp}:${HTTPS_PORT}  (accept the certificate warning once)`);
  console.log('');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    depth.stop();
    process.exit(0);
  });
}

main();
