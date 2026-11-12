// Fake phones: join a session over WebSocket, sync clocks, and upload the synthetic scene
// from test/fixtures when the host fires. Exercises everything except a real camera.
//
//   node scripts/simulate.mjs [--cams 5] [--mode still|burst] [--url http://localhost:4747]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.url || 'http://localhost:4747';
const CAMS = Number(args.cams || 5);
const MODE = args.mode || 'still';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function phone(sid, index, hostKey) {
  const clientId = `sim-${index}`;
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws?s=${sid}`);
  const clock = { offset: 0, rtt: Infinity };
  const uploaded = new Promise((resolve, reject) => {
    ws.on('message', async (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === 'pong') {
        const t1 = performance.now();
        const rtt = t1 - msg.t0;
        if (rtt < clock.rtt) Object.assign(clock, { rtt, offset: msg.ts - (msg.t0 + t1) / 2 });
      }
      if (msg.type === 'arm') {
        try {
          // Wait for the instant like a real phone, then send this seat's frames.
          await sleep(Math.max(0, msg.T - (performance.now() + clock.offset)) + msg.offsets.at(-1));
          for (let k = 0; k < msg.offsets.length; k++) {
            const body = await fs.readFile(path.join(FIXTURES, `c${msg.seat}_t${k}.jpg`));
            const query = new URLSearchParams({ client: clientId, k, dt: (Math.random() * 16 - 8).toFixed(1), w: 960, h: 720 });
            const res = await fetch(`${BASE}/api/s/${sid}/c/${msg.capId}/frame?${query}`, { method: 'POST', body });
            if (!res.ok) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
          }
          resolve(msg.capId);
        } catch (err) {
          reject(err);
        }
      }
    });
  });
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  ws.send(JSON.stringify({ type: 'hello', clientId, hostKey, hasCamera: true, name: `Sim ${index + 1}` }));
  for (let i = 0; i < 5; i++) {
    ws.send(JSON.stringify({ type: 'ping', t0: performance.now(), rtt: clock.rtt }));
    await sleep(40);
  }
  return { ws, clock, uploaded };
}

const created = await fetch(`${BASE}/api/sessions`, { method: 'POST' });
if (!created.ok) throw new Error(`Is the server running at ${BASE}?`);
const { id: sid, hostKey } = await created.json();
console.log(`session ${sid}`);

const phones = [];
for (let i = 0; i < CAMS; i++) phones.push(await phone(sid, i, i === 0 ? hostKey : undefined));
console.log(`${CAMS} phones joined, clock rtt ${phones.map((p) => p.clock.rtt.toFixed(1)).join(' / ')} ms`);

phones[0].ws.send(JSON.stringify({ type: 'fire', mode: MODE }));
const [capId] = await Promise.all(phones.map((p) => p.uploaded));
console.log(`capture ${capId} uploaded; waiting for depth`);

const started = Date.now();
let manifest;
do {
  await sleep(500);
  manifest = await (await fetch(`${BASE}/api/s/${sid}/c/${capId}`)).json();
} while (manifest.status === 'processing' && Date.now() - started < 180000);

for (const p of phones) p.ws.close();
const withDepth = manifest.cameras.flatMap((c) => c.frames).filter((f) => f.depth).length;
console.log(`status ${manifest.status}: ${manifest.cameras.length} cameras, ${withDepth} depth maps, ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log(`${BASE}/v/${sid}/${capId}`);
process.exit(manifest.status === 'done' ? 0 : 1);
