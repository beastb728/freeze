// Reconstruction backend. This file is the only place that knows how a capture becomes 3D;
// today it queues jobs to a warm Python process running a small depth model on the CPU.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

export class DepthQueue {
  constructor(root) {
    this.script = path.join(root, 'worker', 'depth_worker.py');
    // Prefer the project's virtualenv (created by `npm run setup`) when it exists.
    const venv = path.join(root, '.venv', 'bin', 'python');
    this.python = process.env.PYTHON || (fs.existsSync(venv) ? venv : 'python3');
    this.proc = null;
    this.jobs = new Map(); // id -> { resolve, reject, onMessage }
    this.nextId = 1;
    this.disabled = process.env.FREEZE_NO_DEPTH === '1';
  }

  start() {
    const proc = spawn(this.python, ['-u', this.script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: '1', TRANSFORMERS_VERBOSITY: 'error' },
    });
    this.proc = proc;
    let lastError = '';

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const job = this.jobs.get(msg.id);
      if (!job) return;
      if (msg.type === 'frame' || msg.type === 'calib') job.onMessage(msg);
      if (msg.type === 'done') {
        this.jobs.delete(msg.id);
        job.resolve();
      }
      if (msg.type === 'error') {
        this.jobs.delete(msg.id);
        job.reject(new Error(msg.message));
      }
    });
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      if (line.trim()) lastError = line.trim();
    });

    const fail = (reason) => {
      if (this.proc === proc) this.proc = null;
      for (const job of this.jobs.values()) job.reject(new Error(reason));
      this.jobs.clear();
    };
    proc.on('error', (err) => fail(`could not start ${this.python}: ${err.message}`));
    proc.on('exit', (code) => fail(`depth worker exited (${code}): ${lastError}`));
  }

  /**
   * job: { dir, cameras: [[file per instant] per camera] }
   * onMessage fires with { type: 'frame', cam, k, depth, pivot } as each depth map is written,
   * then once with { type: 'calib', calib } describing the rig.
   */
  run(job, onMessage) {
    if (this.disabled) return Promise.reject(new Error('depth disabled by FREEZE_NO_DEPTH'));
    if (!this.proc) this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject, onMessage });
      this.proc.stdin.write(JSON.stringify({ id, ...job }) + '\n', (err) => {
        if (err && this.jobs.delete(id)) reject(err);
      });
    });
  }

  stop() {
    if (this.proc) this.proc.kill();
  }
}
