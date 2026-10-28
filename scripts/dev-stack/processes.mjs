import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

export class ProcessSupervisor {
  constructor({ cwd, env, write = text => process.stdout.write(text), onFailure = () => {} }) {
    this.cwd = cwd;
    this.env = env;
    this.write = write;
    this.onFailure = onFailure;
    this.children = new Set();
    this.processGroups = new Set();
    this.stopping = false;
  }

  start(name, command, args, { env = this.env, cwd = this.cwd, persistent = true } = {}) {
    if (this.stopping) throw new Error("The development stack is stopping.");
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    this.children.add(child);
    if (child.pid) this.processGroups.add(child.pid);
    for (const stream of [child.stdout, child.stderr]) {
      const lines = createInterface({ input: stream });
      lines.on("line", line => this.write(`[${name}] ${line}\n`));
    }
    child.completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        this.children.delete(child);
        if (!persistent && code === 0) this.processGroups.delete(child.pid);
        if (code === 0 || this.stopping) resolve();
        else reject(new Error(`${name} exited (${code ?? signal}).`));
        if (persistent && !this.stopping) this.onFailure(new Error(`${name} stopped unexpectedly (${code ?? signal}).`));
      });
    });
    // Persistent services are observed through onFailure; still handle their rejected completion.
    if (persistent) child.completion.catch(error => this.onFailure(error));
    return child;
  }

  async run(name, command, args, options) {
    await this.start(name, command, args, { ...options, persistent: false }).completion;
  }

  stop() {
    this.stopPromise ??= this.stopChildren();
    return this.stopPromise;
  }

  async stopChildren() {
    this.stopping = true;
    const children = [...this.children];
    const groups = [...this.processGroups];
    const signalGroups = signal => {
      for (const pid of groups) {
        // A process group includes tsx's watcher and PTY children, not just its launcher.
        try { process.kill(-pid, signal); } catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    };
    signalGroups("SIGTERM");
    let timer;
    await Promise.race([
      Promise.allSettled(children.map(child => child.completion)),
      new Promise(resolve => { timer = setTimeout(resolve, 5000); })
    ]);
    clearTimeout(timer);
    // A failed watcher may already be gone while its children are handling SIGTERM.
    await delay(100);
    signalGroups("SIGKILL");
    await Promise.allSettled(children.map(child => child.completion));
    this.processGroups.clear();
  }
}

export async function waitFor(check, { signal, timeoutMs = 180_000, description = "service readiness" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (await check()) return;
    await delay(250, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${description}. Check the service output above.`);
}

export async function monitorReadiness(check, { signal, intervalMs = 5000, failureLimit = 3 } = {}) {
  let failures = 0;
  while (!signal?.aborted) {
    try { await delay(intervalMs, undefined, { signal }); }
    catch (error) { if (signal?.aborted) return; throw error; }
    const ready = await Promise.resolve().then(check).catch(() => false);
    failures = ready ? 0 : failures + 1;
    // A short reload may interrupt HTTP briefly; a sustained dependency failure must stop visibly.
    if (failures >= failureLimit) throw new Error("Development stack readiness failed repeatedly. Check the named service output.");
  }
}
