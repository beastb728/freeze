// End-to-end test in a real browser: headless Chrome tabs with fake cameras act as the host
// and a guest, run a capture through the actual session page, and check the result.
//
//   npm start            (in another terminal)
//   npm test
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BASE = process.env.FREEZE_URL || 'http://localhost:4747';
const CHROME = process.env.CHROME || 'google-chrome';
const DEBUG_PORT = 9377;
const SHOT = process.env.SCREENSHOT; // optional path for a picture of the viewer

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what, fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

/** A minimal Chrome DevTools Protocol client for one tab. */
async function openTab(url) {
  // Each tab gets its own window: a background tab stops receiving video frames, which is
  // not how a phone in someone's hand behaves.
  const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  const browser = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => browser.once('open', resolve).once('error', reject));
  const targetId = await new Promise((resolve) => {
    browser.once('message', (raw) => resolve(JSON.parse(raw).result.targetId));
    browser.send(JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url, newWindow: true } }));
  });
  browser.close();
  const ws = new WebSocket(`ws://127.0.0.1:${DEBUG_PORT}/devtools/page/${targetId}`);
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  let nextId = 1;
  const pending = new Map();
  const errors = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || 'exception');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  const evaluate = async (expression) => {
    const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.result?.exceptionDetails) throw new Error(out.result.exceptionDetails.text);
    return out.result?.result?.value;
  };
  return { send, evaluate, errors };
}

const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'freeze-e2e-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--use-fake-ui-for-media-stream', // grant the camera without a prompt
    '--use-fake-device-for-media-stream', // Chrome's built-in test-pattern camera
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--window-size=900,700',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let failed = false;
const tabs = {};
try {
  await until('Chrome', async () => (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).ok);

  // Host: start a session from the landing page, join with the camera.
  const host = (tabs.host = await openTab(`${BASE}/`));
  await until('landing page', () => host.evaluate(`!!document.getElementById('start')`));
  await host.evaluate(`document.getElementById('start').click()`);
  const sid = await until('session page', () => host.evaluate(`location.pathname.startsWith('/s/') && location.pathname.split('/')[2]`));
  await until('join button', () => host.evaluate(`!!document.getElementById('joinCamera').onclick`));
  await host.evaluate(`document.getElementById('name').value = 'Host'; document.getElementById('joinCamera').click()`);

  // Guest: open the join link, join with the camera.
  const guest = (tabs.guest = await openTab(`${BASE}/s/${sid}`));
  await until('guest join button', () => guest.evaluate(`!!document.getElementById('joinCamera').onclick`));
  await guest.evaluate(`document.getElementById('name').value = 'Guest'; document.getElementById('joinCamera').click()`);

  // Whoever's camera started first has seat 1.
  const seat = (tab) => tab.evaluate(`document.getElementById('seatTitle').textContent`);
  await until('two seated cameras', async () => /of 2$/.test(await seat(host)) && /of 2$/.test(await seat(guest)));
  const hostSeat = await seat(host);
  if (hostSeat === (await seat(guest))) throw new Error(`both tabs claim "${hostSeat}"`);

  // Swap places in the line-up and back.
  const second = hostSeat === 'Camera 2 of 2' ? host : guest;
  await second.evaluate(`document.getElementById('moveLeft').click()`);
  await until('seat swap', async () => (await seat(second)) === 'Camera 1 of 2');
  await second.evaluate(`document.getElementById('moveRight').click()`);
  await until('seat swap back', async () => (await seat(second)) === 'Camera 2 of 2');
  await until('clock sync', () => guest.evaluate(`document.getElementById('syncText').textContent.startsWith('Clock')`));
  console.log(`session ${sid}: host and guest joined with cameras; ${await guest.evaluate(`document.getElementById('syncText').textContent`)}`);

  for (const mode of ['still', 'burst']) {
    const before = await host.evaluate(`document.querySelectorAll('#results a').length`);
    await until('idle', () => host.evaluate(`!document.getElementById('fire').disabled`));
    await host.evaluate(`document.querySelector('[data-mode=${mode}]').click(); document.getElementById('fire').click()`);
    const href = await until(
      `${mode} result link`,
      () => host.evaluate(`document.querySelectorAll('#results a').length > ${before} && document.querySelector('#results a').getAttribute('href')`),
      30000,
    );
    const capId = href.split('/').pop();
    const manifest = await until(
      `${mode} depth`,
      async () => {
        const m = await (await fetch(`${BASE}/api/s/${sid}/c/${capId}`)).json();
        return m.status !== 'processing' && m;
      },
      180000,
    );
    const frames = manifest.cameras.flatMap((c) => c.frames);
    const expected = 2 * (mode === 'still' ? 1 : 6);
    const worst = Math.max(...frames.map((f) => Math.abs(f.dt)));
    console.log(`  offsets from each instant, ms: ${manifest.cameras.map((c) => c.frames.map((f) => f.dt).join(' ')).join('  |  ')}`);
    console.log(
      `${mode}: status ${manifest.status}, ${manifest.cameras.length} cameras, ${frames.length} frames, ` +
        `${frames.filter((f) => f.depth).length} depth maps, worst frame ${worst.toFixed(1)} ms from its instant, ` +
        `spread ${manifest.syncSpreadMs} ms, ${manifest.cameras[0].w}x${manifest.cameras[0].h}`,
    );
    if (manifest.status !== 'done' || frames.length !== expected || frames.some((f) => !f.depth)) failed = true;
    if (worst > 60) {
      console.log('  frames landed further from the instant than a 30 fps camera should allow');
      failed = true;
    }

    if (mode === 'burst') {
      const viewer = await openTab(`${BASE}${href}?view=0.5`);
      await until('viewer', () => viewer.evaluate(`document.getElementById('message').hidden && !document.getElementById('bar').hidden`));
      await sleep(2500);
      const info = await viewer.evaluate(`document.getElementById('info').textContent`);
      console.log(`viewer: "${info}", ${viewer.errors.length} errors`);
      if (viewer.errors.length) failed = true;
      if (SHOT) {
        const shot = await viewer.send('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(SHOT, Buffer.from(shot.result.data, 'base64'));
      }
    }
  }

  for (const [name, tab] of [['host', host], ['guest', guest]]) {
    if (tab.errors.length) {
      console.log(`${name} page errors:\n  ${tab.errors.join('\n  ')}`);
      failed = true;
    }
  }
} catch (err) {
  console.error(`FAILED: ${err.message}`);
  for (const [name, tab] of Object.entries(tabs)) {
    const state = await tab
      .evaluate(`[document.getElementById('joinError').textContent, document.getElementById('seatTitle').textContent, document.getElementById('status').textContent, document.getElementById('syncText').textContent].join(' | ')`)
      .catch(() => 'unreachable');
    console.error(`  ${name}: ${state}${tab.errors.length ? ` | errors: ${tab.errors.join('; ')}` : ''}`);
  }
  failed = true;
} finally {
  chrome.kill();
  await sleep(300);
  await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? 'e2e FAILED' : 'e2e passed');
process.exit(failed ? 1 : 0);
