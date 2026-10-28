import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import WebSocket from "ws";
import { loadState, portsFromEnvironment } from "./config.mjs";
import { waitFor } from "./processes.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const launcher = join(root, "scripts", "dev-stack.mjs");
const ports = portsFromEnvironment();
const origin = `http://127.0.0.1:${ports.web}`;
const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function descendants(pid) {
  const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8").then(text => text.trim().split(/\s+/).filter(Boolean).map(Number), () => []);
  return [pid, ...(await Promise.all(children.map(descendants))).flat()];
}

let state;
let failure;
let output = "";
let cookie = "";
let csrf = {};
let terminal;
const ownedPids = new Set();
const child = spawn(process.execPath, [launcher], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
const completion = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
child.once("error", error => { failure = error; });
child.once("exit", (code, signal) => { failure ??= new Error(`Development stack exited before smoke completion (${code ?? signal}).`); });
for (const stream of [child.stdout, child.stderr]) {
  const lines = createInterface({ input: stream });
  lines.on("line", line => {
    // Redact complete lines, even when a token arrives in multiple stream chunks.
    const safe = line.replace(/One-time owner setup token: .*/, "One-time owner setup token: [redacted]");
    output = (output + safe + "\n").slice(-30_000);
  });
}

async function request(path, body) {
  const response = await fetch(origin + path, {
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json", ...csrf }) },
    signal: AbortSignal.timeout(30_000)
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) cookie = cookies.map(value => value.split(";")[0]).join("; ");
  assert.equal(response.ok, true, `${path} returned HTTP ${response.status}`);
  return response.json();
}

try {
  await waitFor(async () => {
    if (failure) throw failure;
    state = await loadState(root).catch(() => null);
    try {
      const response = await fetch(origin + "/readyz", { signal: AbortSignal.timeout(3000) });
      const readiness = await response.json();
      return readiness.ok && readiness.dependencies.worker === "RUNNING" && readiness.dependencies.cliHost === "RUNNING";
    } catch { return false; }
  }, { timeoutMs: 15 * 60_000, description: "the complete source stack" });
  process.stdout.write("Source stack ready; checking owner setup and sign-in.\n");
  const token = await readFile(join(state.directory, "secrets", "setup-token"), "utf8");
  const password = randomBytes(24).toString("hex");
  const email = "source-smoke@example.invalid";
  const claimed = await request("/api/setup/claim", { token, email, password });
  assert.equal(claimed.isAuthenticated, true);
  cookie = "";
  const login = await request("/api/auth/login", { email, password });
  assert.equal(login.isAuthenticated, true);
  const csrfResponse = await request("/api/auth/csrf");
  csrf = { [csrfResponse.headerName]: csrfResponse.csrfToken };
  const starter = await request("/api/setup/starter-room", {});
  assert.equal(starter.room.name, "Getting Started");
  const panes = await request(`/api/panes?roomId=${encodeURIComponent(starter.room.id)}`);
  const pane = panes.data.find(value => value.terminalRuntimeId === "cli:opencode");
  assert.ok(pane, "Getting Started must contain the OpenCode pane");
  const allocated = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session`, { runtimeId: "cli:opencode", includeTranscript: true });
  const params = new URLSearchParams({
    sessionId: allocated.websocket.sessionId, token: allocated.websocket.token,
    protocolVersion: "2", browserClientId: randomUUID(), tabLineageId: randomUUID(), pageClientId: randomUUID(),
    clientMode: "INTERACTIVE", initialCols: "100", initialRows: "30"
  });
  // Allocation is lazy. The same WebSocket attach used by the UI starts the actual PTY.
  terminal = new WebSocket(`${origin.replace("http:", "ws:")}/api/panes/${encodeURIComponent(pane.id)}/cli/terminal?${params}`, {
    headers: { cookie, origin }
  });
  let terminalOutput = "";
  let terminalError;
  terminal.on("error", error => { terminalError = error; });
  terminal.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.type === "output") terminalOutput += message.data ?? "";
    if (message.type === "error") terminalError = new Error("The OpenCode terminal reported an attach error.");
  });
  await waitFor(async () => {
    if (failure) throw failure;
    if (terminalError) throw terminalError;
    const session = await request(`/api/panes/${encodeURIComponent(pane.id)}/cli/session?includeTranscript=true`);
    return session?.session.status === "RUNNING" && terminalOutput.length > 0;
  }, { timeoutMs: 60_000, description: "a running OpenCode PTY with terminal output" });
  for (const pid of await descendants(child.pid)) ownedPids.add(pid);
  process.stdout.write("Source stack smoke passed: owner claim, fresh sign-in, Getting Started and running OpenCode pane.\n");
} catch (error) {
  process.stderr.write(output + `\nSource stack smoke failed: ${error.message}\n`);
  throw error;
} finally {
  terminal?.terminate();
  state ??= await loadState(root).catch(() => null);
  for (const pid of await descendants(child.pid)) ownedPids.add(pid);
  try {
    await exec(process.execPath, [launcher, "reset"], { cwd: root, timeout: 60_000 });
  } finally {
    if (exists(child.pid)) child.kill("SIGTERM");
    await completion;
  }
  await waitFor(() => ![...ownedPids].some(exists), { timeoutMs: 5000, description: "owned process cleanup" });
  for (const pid of ownedPids) assert.equal(exists(pid), false, `Owned process ${pid} survived reset`);
  if (state) {
    const filter = `label=com.docker.compose.project=${state.project}`;
    for (const args of [["ps", "--all", "--quiet", "--filter", filter], ["volume", "ls", "--quiet", "--filter", filter]]) {
      const { stdout } = await exec("docker", args, { cwd: root });
      assert.equal(stdout.trim(), "", "No development containers or volumes may survive reset");
    }
    assert.equal(await loadState(root), null);
  }
  process.stdout.write("Source stack cleanup passed: no owned processes, containers, volumes or state remain.\n");
}
