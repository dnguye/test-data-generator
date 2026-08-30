/* Supervises the generation worker.

   One long-lived child, not one per request: faker's bundle costs ~0.4s to
   parse and paying that per call would dominate every response. The child is
   respawned on demand, so a formula that hangs or calls process.exit() costs
   one request rather than the service. */
import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "worker.mjs");

export class GeneratorPool {
  constructor({ timeoutMs = 15000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.ready = null;
    this.catalog = [];
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      /* env:{} is the load-bearing argument here -- see worker.mjs. */
      const child = fork(WORKER, [], { env: {}, stdio: ["ignore", "inherit", "inherit", "ipc"] });
      this.child = child;

      const boot = setTimeout(() => reject(new Error("generator worker did not start")), 30000);

      child.on("message", msg => {
        if (msg && msg.ready) {
          clearTimeout(boot);
          this.catalog = msg.catalog || [];
          resolve(this);
          return;
        }
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error), { kind: "generate" }));
      });

      /* A dead worker fails every request it was holding, then gets replaced on
         the next call rather than eagerly, so a crash loop cannot spin. */
      child.on("exit", code => {
        clearTimeout(boot);
        const err = new Error("generator worker exited (code " + code + ")");
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
        this.pending.clear();
        if (this.child === child) { this.child = null; this.ready = null; }
        reject(err);
      });
    });
    return this.ready;
  }

  async run(job) {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        /* The worker is single threaded and each job runs to completion, so a
           job that overruns cannot be cancelled -- only the worker can. */
        const dead = this.child;
        this.child = null; this.ready = null;
        if (dead) dead.kill("SIGKILL");
        reject(Object.assign(new Error("generation timed out"), { kind: "timeout" }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send({ id, op: "generate", ...job });
    });
  }

  stop() {
    if (this.child) this.child.kill();
    this.child = null; this.ready = null;
  }
}
