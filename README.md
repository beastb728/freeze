# Freeze

> **Work in progress.** This project is still being built. It runs end to end with simulated
> phones, but it has not been tested on real phones yet, and things will change.

## About

Freeze turns a group of friends' phones into a camera rig. Everyone scans a QR code and points
their phone at the same moment. One tap, every phone captures the same instant, and everyone
gets a link to a scene they can drag to orbit and scrub through time.

A photo captures a moment from one angle. The frozen spin-around shot from action films needs
dozens of cameras on a rig. Freeze aims to give ordinary people that shot with the phones
already in their pockets.

It runs entirely on a laptop with **no GPU**, and phones need nothing installed.

## Run it

```bash
npm install
```

```bash
npm run setup
```

```bash
npm start
```

`npm run setup` creates a Python virtualenv in `.venv` for the depth step (it reuses a system
PyTorch if you have one). Skip it and the viewer still works, as a cross-fade between cameras
with no parallax.

Open `http://localhost:4747` on the laptop, press **Start a session**, choose **Join without a
camera**, and have each phone scan the QR code. Phones must be on the same Wi-Fi as the laptop.

- Phones connect over `https://<laptop-ip>:4748` with a self-signed certificate (browsers only
  allow camera access on secure pages). Each phone shows a one-time warning: choose
  *Advanced → Proceed* (Chrome) or *Show Details → visit this website* (Safari).
- To avoid the warning, or to let people join from outside your Wi-Fi, run a tunnel and tell
  Freeze its public address:

  ```bash
  cloudflared tunnel --url http://localhost:4747
  ```

  ```bash
  PUBLIC_URL=https://<the-address-it-prints> npm start
  ```

The first capture downloads a 100 MB depth model (Depth Anything V2 Small, Apache-2.0) into the
Hugging Face cache. Ports can be changed with `PORT` and `HTTPS_PORT`.

## How a capture works

1. **Session.** One person creates a session. Others join by QR. Each phone gets a seat number
   and people stand in that order, left to right, aiming the on-screen circle at the subject.
   Anyone can shift their seat left or right if they end up standing somewhere else.
2. **Shared clock.** Every phone pings the server over a WebSocket, NTP-style, and keeps the
   lowest-latency sample as its clock offset. The error is at most half the round trip.
3. **Scheduled capture, picked after the fact.** Browsers cannot fire a shutter at a precise
   time, but they can timestamp video frames. When the host taps *Freeze*, the server names an
   instant three seconds ahead. Each phone watches its live camera frames around that instant
   and keeps the one whose capture timestamp is closest. In *Time slice* mode it does this for
   six instants 120 ms apart. A phone whose frame is more than 120 ms off is left out.
4. **Progressive result.** As soon as the photos land, the link works as a cross-fade orbit.
   A worker then estimates depth for every photo on the CPU (about one second per photo) and
   the viewer upgrades itself to true parallax.
5. **Calibration.** The viewer models the rig as cameras on an arc aimed at one pivot. The
   worker searches for the angle between each neighbouring pair, and a depth range and pivot
   depth per camera, that make one camera's depth mesh land on the next camera's photo.
6. **Viewer.** Each photo is a depth-displaced mesh. Dragging rotates the two nearest cameras'
   meshes about the pivot and blends them, weighting down stretched surfaces so one camera
   fills the other's holes. Includes time scrubbing, share, and video export of the orbit.
   Adding `?view=1.5` to a scene link opens it at a fixed viewpoint.

## Layout

| Path | What it is |
| --- | --- |
| `server/index.js` | HTTP + HTTPS + WebSocket server: sessions, seats, clock sync, uploads, manifests |
| `server/depth.js` | Keeps the Python worker warm and queues captures to it |
| `worker/depth_worker.py` | Depth Anything V2 Small on CPU; writes one depth map per photo |
| `worker/calibrate.py` | Fits camera gaps, depth ranges and pivot depths; runnable alone on a capture folder |
| `public/session.*` | Lobby, camera, clock sync and frame selection (host and guests share it) |
| `public/viewer.*` | WebGL orbit viewer |
| `scripts/make_test_scene.py` | Renders a synthetic five-camera, six-instant scene into `test/fixtures` |
| `scripts/simulate.mjs` | Fake phones that join a session and upload the synthetic scene |
| `scripts/e2e.mjs` | Drives headless Chrome tabs with fake cameras through real captures |
| `data/` | Captures on disk: photos, depth maps, `manifest.json` |

## Testing without phones

With the server running:

```bash
npm run fixtures
```

```bash
npm run simulate -- --cams 5 --mode burst
```

```bash
npm test
```

`simulate` pushes the synthetic scene through upload, depth and calibration and prints a viewer
link. `npm test` opens two headless Chrome windows with Chrome's fake camera, joins a session
through the real pages, swaps seats, runs a still and a time-slice capture, and checks frame
timing, depth maps and the viewer.

## Limits

- **Not yet tried on real phones.** Everything above is verified with simulated phones and
  with desktop Chrome's fake camera. iOS Safari in particular reports frame times less
  precisely than Chrome, so expect looser sync there until measured.
- The rig model is an arc around one pivot. Phones at different heights or distances, or not
  aimed at the same thing, show up as ghosting halfway between cameras.
- Depth comes from each photo alone, so two cameras can disagree about a surface. The blend
  hides most of it; object edges can still fringe mid-gap.
- Frame choice is limited by the camera's frame rate: at 30 fps the worst case is about 17 ms
  off the target instant, plus clock error. Fine for people, not for a popping balloon.
- The orbit covers the arc the phones stood on, plus a little past each end.
- Sessions live in memory. Finished captures stay on disk and their links keep working.

## Where a GPU comes in later

`server/depth.js` is the only place that knows how a capture gets reconstructed. Swapping it for
a call to a hosted feed-forward multi-view model (camera poses plus a Gaussian splat) replaces
the arc model with real geometry and widens the orbit. That is a rented, pay-per-second GPU,
never a local one.
