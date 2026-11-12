// Session page: lobby, shared clock, and picking the camera frame nearest the agreed instant.

const $ = (id) => document.getElementById(id);
const sid = location.pathname.split('/')[2].toUpperCase();
const hostKey = localStorage.getItem(`freeze.host.${sid}`);
// Per tab, so a reload keeps the same seat but two tabs are two cameras.
const clientId = sessionStorage.getItem('freeze.client') || crypto.randomUUID?.() || `c${Date.now()}${Math.random().toString(36).slice(2)}`;
sessionStorage.setItem('freeze.client', clientId);

const video = $('cam');
let ws = null;
let hasCamera = false;
let me = { isHost: false, seat: null };
let roster = { clients: [], captures: [], busy: false };
let mode = 'still';
let capture = null; // the capture in flight on this phone
let audio = null;

// ------------------------------------------------------------ shared clock

// offset maps this device's performance.now() onto the server's clock.
const clock = { offset: 0, rtt: Infinity, samples: [] };
const serverNow = () => performance.now() + clock.offset;

function ping() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'ping', t0: performance.now(), rtt: clock.rtt }));
  }
}

function onPong(msg) {
  const t1 = performance.now();
  const rtt = t1 - msg.t0;
  // Assume the reply took as long as the request; the error is at most rtt / 2.
  clock.samples.push({ rtt, offset: msg.ts - (msg.t0 + t1) / 2 });
  if (clock.samples.length > 15) clock.samples.shift();
  const best = clock.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  clock.offset = best.offset;
  clock.rtt = best.rtt;
  renderSync();
}

function renderSync() {
  const pill = $('syncPill');
  if (clock.samples.length < 4) return;
  const error = Math.max(1, Math.ceil(clock.rtt / 2));
  pill.className = `pill ${error <= 15 ? 'good' : 'fair'}`;
  $('syncText').textContent = `Clock ±${error} ms`;
}

// ------------------------------------------------------------ connection

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?s=${sid}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', clientId, hostKey, hasCamera, name: $('name').value.trim() || 'Phone' }));
    for (let i = 0; i < 8; i++) setTimeout(ping, i * 120);
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'pong') onPong(msg);
    else if (msg.type === 'welcome') me.isHost = msg.isHost;
    else if (msg.type === 'state') {
      roster = msg;
      render();
    } else if (msg.type === 'arm') onArm(msg);
    else if (msg.type === 'error') setStatus(msg.message);
  };
  ws.onclose = () => {
    $('syncPill').className = 'pill';
    $('syncText').textContent = 'Reconnecting';
    setTimeout(connect, 1000);
  };
}
setInterval(ping, 2000);

// ------------------------------------------------------------ lobby

const ordinal = (n) => {
  const tail = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (tail[(v - 20) % 10] || tail[v] || tail[0]);
};

function setStatus(text) {
  $('status').textContent = text;
}

function render() {
  const mine = roster.clients.find((c) => c.id === clientId);
  const cameras = roster.clients.filter((c) => c.seat).sort((a, b) => a.seat - b.seat);
  me.seat = mine ? mine.seat : null;

  $('seatCard').hidden = !me.seat;
  if (me.seat) {
    $('seatTitle').textContent = `Camera ${me.seat} of ${cameras.length}`;
    $('seatHint').textContent =
      cameras.length > 1 ? `Stand ${ordinal(me.seat)} from the left. Aim the circle at the subject.` : 'Aim the circle at the subject.';
    $('moveLeft').disabled = me.seat === 1 || roster.busy;
    $('moveRight').disabled = me.seat === cameras.length || roster.busy;
  }

  const others = roster.clients.filter((c) => !c.seat);
  $('roster').replaceChildren(
    ...[...cameras, ...others].map((c) => {
      const pill = document.createElement('span');
      pill.className = `pill${c.id === clientId ? ' me' : ''}`;
      pill.textContent = `${c.seat ? `${c.seat} · ` : ''}${c.name}${c.isHost ? ' (host)' : ''}`;
      return pill;
    }),
  );

  $('hostControls').hidden = !me.isHost;
  $('fire').disabled = roster.busy || !cameras.length;
  if (!capture && !roster.busy) {
    if (!cameras.length) setStatus('Waiting for a camera to join.');
    else if (me.isHost) setStatus(`${cameras.length} camera${cameras.length > 1 ? 's' : ''} ready.`);
    else setStatus('Hold steady. The host starts the capture.');
  }

  const labels = { capturing: 'capturing', processing: 'adding depth', done: 'ready', 'photos-only': 'ready', failed: 'failed' };
  $('results').replaceChildren(
    ...roster.captures
      .map((c, i) => ({ ...c, n: i + 1 }))
      .filter((c) => c.status !== 'capturing' && c.status !== 'failed')
      .reverse()
      .map((c) => {
        const a = document.createElement('a');
        a.className = 'btn small';
        a.href = c.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `Open scene ${c.n} · ${labels[c.status]}`;
        return a;
      }),
  );
}

$('moveLeft').onclick = () => ws.send(JSON.stringify({ type: 'move', dir: -1 }));
$('moveRight').onclick = () => ws.send(JSON.stringify({ type: 'move', dir: 1 }));
$('fire').onclick = () => ws.send(JSON.stringify({ type: 'fire', mode }));
for (const button of document.querySelectorAll('[data-mode]')) {
  button.onclick = () => {
    mode = button.dataset.mode;
    for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b === button));
  };
}
$('invite').onclick = () => ($('inviteSheet').hidden = false);
$('inviteClose').onclick = () => ($('inviteSheet').hidden = true);

// ------------------------------------------------------------ capture

/** When a video frame was captured, on this device's performance.now() timeline. */
function frameTime(callbackNow, meta) {
  const t = meta && typeof meta.captureTime === 'number' ? meta.captureTime : callbackNow;
  // Some browsers report captureTime on another clock; distrust anything implausible.
  return Math.abs(t - callbackNow) < 500 ? t : callbackNow;
}

function onArm(arm) {
  runCountdown(arm);
  if (!arm.seat || !hasCamera || !video.videoWidth) return;

  const maxSide = arm.offsets.length > 1 ? 1280 : 1920;
  const scale = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * scale);
  const h = Math.round(video.videoHeight * scale);
  // One slot per instant. Each holds the closest frame seen so far.
  const slots = arm.offsets.map((offset) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    return { canvas, target: arm.T + offset - clock.offset, error: Infinity, dt: 0 };
  });
  const endAt = slots[slots.length - 1].target + 250;
  capture = { arm, slots, endAt, w, h };
  // If frames stop arriving (tab hidden, camera stalled), finish with what we have.
  capture.fallback = setTimeout(finishCapture, endAt - performance.now() + 700);
}

function onVideoFrame(callbackNow, meta) {
  if (capture) {
    const t = frameTime(callbackNow, meta);
    for (const slot of capture.slots) {
      const error = Math.abs(t - slot.target);
      if (error < slot.error && t > slot.target - 200) {
        slot.canvas.getContext('2d').drawImage(video, 0, 0, capture.w, capture.h);
        slot.error = error;
        slot.dt = t - slot.target;
      }
    }
    if (t > capture.endAt) finishCapture();
  }
  watchFrames();
}

function watchFrames() {
  if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(onVideoFrame);
  else requestAnimationFrame((t) => onVideoFrame(t, null));
}

async function finishCapture() {
  const done = capture;
  if (!done) return;
  capture = null;
  clearTimeout(done.fallback);
  setStatus('Sending…');

  try {
    await Promise.all(
      done.slots.map(async (slot, k) => {
        if (slot.error === Infinity) {
          slot.canvas.getContext('2d').drawImage(video, 0, 0, done.w, done.h);
          slot.dt = performance.now() - slot.target;
        }
        const blob = await new Promise((resolve) => slot.canvas.toBlob(resolve, 'image/jpeg', 0.9));
        const query = new URLSearchParams({ client: clientId, k, dt: slot.dt.toFixed(1), w: done.w, h: done.h });
        await upload(`/api/s/${sid}/c/${done.arm.capId}/frame?${query}`, blob);
      }),
    );
    setStatus('Sent. The scene link appears above.');
  } catch {
    setStatus('Could not send this capture. Check the connection and try again.');
  }
}

async function upload(url, blob, attempt = 0) {
  try {
    const res = await fetch(url, { method: 'POST', body: blob, headers: { 'content-type': 'image/jpeg' } });
    if (!res.ok && res.status >= 500) throw new Error();
    if (!res.ok) throw Object.assign(new Error(), { fatal: true });
  } catch (err) {
    if (err.fatal || attempt >= 2) throw err;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return upload(url, blob, attempt + 1);
  }
}

function runCountdown(arm) {
  const count = $('count');
  count.hidden = false;
  beepAt(arm.T - 3000, 660);
  beepAt(arm.T - 2000, 660);
  beepAt(arm.T - 1000, 660);
  beepAt(arm.T, 1320);
  setStatus('Hold still…');

  const tick = () => {
    const left = arm.T - serverNow();
    if (left > 0) {
      count.textContent = Math.ceil(left / 1000);
      requestAnimationFrame(tick);
      return;
    }
    count.hidden = true;
    const flash = $('flash');
    flash.classList.remove('go');
    void flash.offsetWidth; // restart the animation
    flash.classList.add('go');
    if (!capture) setStatus(arm.seat ? 'Sending…' : 'Captured. The scene link appears above.');
  };
  tick();
}

function beepAt(serverTime, frequency) {
  if (!audio) return;
  const when = audio.currentTime + (serverTime - serverNow()) / 1000;
  if (when < audio.currentTime) return;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = frequency;
  gain.gain.setValueAtTime(0.15, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.12);
  osc.connect(gain).connect(audio.destination);
  osc.start(when);
  osc.stop(when + 0.13);
}

// ------------------------------------------------------------ joining

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  await video.play();
  video.hidden = false;
  $('crosshair').hidden = false;
  watchFrames();
}

async function join(withCamera) {
  $('joinError').textContent = '';
  localStorage.setItem('freeze.name', $('name').value.trim());
  try {
    audio = new (window.AudioContext || window.webkitAudioContext)();
  } catch {
    audio = null;
  }

  if (withCamera) {
    try {
      if (!navigator.mediaDevices) throw new Error('insecure');
      await startCamera();
      hasCamera = true;
    } catch (err) {
      $('joinError').textContent =
        err.message === 'insecure'
          ? 'This page needs a secure (https) address to use the camera.'
          : 'No camera available. Allow camera access, or join without one.';
      return;
    }
    // Keep the screen awake while this phone is part of the rig.
    const keepAwake = () => navigator.wakeLock?.request('screen').catch(() => {});
    keepAwake();
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());
  } else {
    $('director').hidden = false;
  }

  $('joinSheet').hidden = true;
  $('bottombar').hidden = false;
  connect();
}

async function init() {
  $('codePill').textContent = sid;
  $('name').value = localStorage.getItem('freeze.name') || '';

  const res = await fetch(`/api/s/${sid}`).catch(() => null);
  if (!res || !res.ok) {
    $('joinTitle').textContent = 'This session has ended';
    $('joinText').innerHTML = 'Sessions close when the server restarts. <a href="/" style="color:var(--accent)">Start a new one</a>.';
    $('joinSheet').querySelector('.stack').hidden = true;
    return;
  }
  const { joinUrl } = await res.json();
  for (const el of document.querySelectorAll('[data-joinurl]')) el.textContent = joinUrl;
  $('inviteQr').src = $('directorQr').src = `/api/s/${sid}/qr.svg`;
  if (hostKey) {
    $('joinTitle').textContent = 'You are the host';
    $('joinText').textContent = 'Use this device as a camera too, or just run the session from it.';
  }

  $('joinCamera').onclick = () => join(true);
  $('joinDirector').onclick = () => join(false);
}

init();
