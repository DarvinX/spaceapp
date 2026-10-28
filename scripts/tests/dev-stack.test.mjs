import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { createServer } from "node:http";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { dependencyCompose, dependencyImage, dockerEnvironment, loadState, openCodePackage, portsFromEnvironment, prepareState, projectName, sourceEnvironment } from "../dev-stack/config.mjs";
import { requestShutdown, startControl } from "../dev-stack/control.mjs";
import { openCodeEnvironment } from "../dev-stack/opencode-wrapper.mjs";
import { withLifecycleLock } from "../dev-stack/lifecycle.mjs";
import { monitorReadiness, ProcessSupervisor, waitFor } from "../dev-stack/processes.mjs";

const repo = new URL("../../", import.meta.url);
const exec = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "sd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "starter-memory"));
  for (const name of ["space_memory.md", "space_memory_monthly.md", "installation-guide.md"]) {
    await writeFile(join(root, "starter-memory", name), "Starter fixture\n");
  }
  return root;
}

test("ports are validated before starting services", () => {
  const defaults = portsFromEnvironment({});
  assert.equal(defaults.web, 5911);
  assert.equal(portsFromEnvironment({ SPACE_DEV_API_PORT: "6001" }).api, 6001);
  for (const value of ["4910", "4911", "65536", "0", "no", " 6000", "6000; rm -rf ."]) {
    assert.throws(() => portsFromEnvironment({ SPACE_DEV_API_PORT: value }));
  }
  assert.throws(() => portsFromEnvironment({ SPACE_DEV_WEB_PORT: "5910" }), /different/);
});

test("dependency images and OpenCode version come from the current distribution sources", async () => {
  const template = await readFile(new URL("packages/run-spaceapp/templates/compose.yml", repo), "utf8");
  for (const name of ["postgres", "temporal"]) assert.match(dependencyImage(template, name), /@sha256:[a-f0-9]{64}$/);
  assert.throws(() => dependencyImage(template.replaceAll("@sha256:", "@sha512:"), "postgres"), /literal digest/);
  assert.throws(() => dependencyImage(template, "not-a-service"));
  const dockerfile = await readFile(new URL("Dockerfile", repo), "utf8");
  assert.match(openCodePackage(dockerfile), /^@opencode\/cli@\d+\.\d+\.\d+$/);
  assert.equal(openCodePackage("RUN npm install opencode-ai@1.2.3"), "opencode-ai@1.2.3");
  assert.throws(() => openCodePackage("RUN npm install opencode-ai@latest"));
});

test("each checkout owns independent secrets, ports and resources", async t => {
  const root = await fixture(t);
  const otherRoot = await fixture(t);
  const state = await prepareState(root, portsFromEnvironment({}));
  const second = await prepareState(otherRoot, portsFromEnvironment({}));
  const secret = name => readFile(join(state.directory, "secrets", name), "utf8");
  assert.notEqual(state.project, second.project);
  assert.equal(state.project, projectName(root));
  const password = await secret("postgres-password");
  assert.notEqual(password, await readFile(join(second.directory, "secrets", "postgres-password"), "utf8"));
  await prepareState(root, portsFromEnvironment({}));
  assert.equal(await secret("postgres-password"), password, "restart preserves the database credentials");
  for (const name of ["postgres-password", "session-secret", "setup-token", "control-token", "opencode-password"]) {
    assert.equal((await stat(join(state.directory, "secrets", name))).mode & 0o777, 0o600);
    assert.equal((await secret(name)).length, 64);
  }
  assert.equal((await stat(state.directory)).mode & 0o777, 0o700);
  await assert.rejects(prepareState(root, portsFromEnvironment({ SPACE_DEV_API_PORT: "6000" })), /reset/);
});

test("existing unowned state and symlinked state directories are refused", async t => {
  const root = await fixture(t);
  await mkdir(join(root, ".dev-stack"));
  await assert.rejects(prepareState(root, portsFromEnvironment({})));
  await rm(join(root, ".dev-stack"), { recursive: true });
  const target = await fixture(t);
  await symlink(target, join(root, ".dev-stack"));
  await assert.rejects(loadState(root), /not a symlink/);
  assert.equal((await stat(target)).isDirectory(), true);
});

test("a symlink cannot redirect secrets or reusable runtime directories", async t => {
  const root = await fixture(t);
  const state = await prepareState(root, portsFromEnvironment({}));
  const outside = join(root, "existing-secret");
  await writeFile(outside, "do not change", { mode: 0o644 });
  await rm(join(state.directory, "secrets", "session-secret"));
  await symlink(outside, join(state.directory, "secrets", "session-secret"));
  await assert.rejects(prepareState(root, portsFromEnvironment({})), /unsafe development state file/);
  assert.equal(await readFile(outside, "utf8"), "do not change");
  assert.equal((await stat(outside)).mode & 0o777, 0o644);
  await rm(join(state.directory, "secrets"), { recursive: true });
  await symlink(join(root, "starter-memory"), join(state.directory, "secrets"));
  await assert.rejects(prepareState(root, portsFromEnvironment({})), /unsafe development state directory/);
});

test("compose exposes only loopback ports, mounts no source and declares only owned storage", () => {
  const state = { directory: "/checkout/.dev-stack", ports: portsFromEnvironment({}) };
  const images = { postgres: "postgres@sha256:" + "a".repeat(64), temporal: "temporal@sha256:" + "b".repeat(64) };
  const compose = dependencyCompose(state, images);
  assert.deepEqual(Object.keys(compose.services), ["postgres", "temporal"]);
  for (const service of Object.values(compose.services)) {
    for (const port of service.ports) assert.match(port, /^127\.0\.0\.1:\d+:\d+$/);
    assert.ok(!service.environment.POSTGRES_PASSWORD && !service.environment.POSTGRES_PWD);
    assert.ok(!service.volumes?.some(value => value.includes("/var/run/docker.sock") || value.startsWith("/")));
  }
  assert.deepEqual(compose.volumes, { postgres: {} });
  assert.equal(compose.secrets["postgres-password"].file, "./secrets/postgres-password");
});

test("source processes cannot inherit operator credentials or live settings", async t => {
  const root = await fixture(t);
  const state = await prepareState(root, portsFromEnvironment({}));
  const inherited = {
    PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/operator", OPENAI_API_KEY: "operator-secret",
    SPACE_DATABASE_URL: "postgresql://live/live", SPACE_CLI_HOST_SOCKET: "/run/live.sock", NODE_OPTIONS: "--require=/bad.js"
  };
  const env = await sourceEnvironment(state, inherited);
  assert.equal(env.SPACE_DEV_LOGIN, "false");
  assert.equal(env.SPACE_INSTANCE, "dev");
  assert.equal(env.SPACEAPP_WORKFLOWS_ENABLED, "true");
  assert.equal(env.SPACE_API_HOST, "127.0.0.1");
  assert.equal(env.SPACE_WEB_HOST, "127.0.0.1");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.ok(env.HOME.startsWith(state.directory));
  assert.ok(env.SPACE_CLI_HOST_SOCKET.startsWith(state.directory));
  assert.equal(new URL(env.SPACE_DATABASE_URL).pathname, "/spaceapp_dev");
  assert.deepEqual(dockerEnvironment({ ...inherited, DOCKER_HOST: "unix:///tmp/docker.sock" }), {
    PATH: "/usr/bin:/bin", LANG: "C.UTF-8", HOME: "/operator", DOCKER_HOST: "unix:///tmp/docker.sock"
  });
  const providerEnv = await openCodeEnvironment(state);
  assert.equal(providerEnv.OPENAI_API_KEY, undefined);
  assert.equal(providerEnv.OPENCODE_SERVER_USERNAME, "opencode");
  assert.ok(providerEnv.XDG_CONFIG_HOME.startsWith(state.directory));
});

test("OpenCode credential checks authenticate to the running local server and fail when it is unavailable", async t => {
  const root = await fixture(t);
  let expectedAuthorization;
  let healthy = true;
  const server = createServer((request, response) => {
    response.statusCode = healthy && request.url === "/api/info" && request.headers.authorization === expectedAuthorization ? 200 : 401;
    response.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const state = await prepareState(root, portsFromEnvironment({ SPACE_DEV_OPENCODE_PORT: String(server.address().port) }));
  const password = await readFile(join(state.directory, "secrets", "opencode-password"), "utf8");
  expectedAuthorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const bin = join(state.directory, "vendor", "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const code = `import {runOpenCode} from ${JSON.stringify(new URL("../dev-stack/opencode-wrapper.mjs", import.meta.url).href)}; await runOpenCode(${JSON.stringify(state.directory)}, ["credential-status"]);`;
  const result = await exec(process.execPath, ["--input-type=module", "-e", code]);
  assert.equal(result.stdout, "READY\n");
  healthy = false;
  await assert.rejects(exec(process.execPath, ["--input-type=module", "-e", code]), /server is unavailable/);
});

test("OpenCode login and credential import use the normal CLI actions with isolated state", async t => {
  const root = await fixture(t);
  const state = await prepareState(root, portsFromEnvironment({}));
  const bin = join(state.directory, "vendor", "node_modules", ".bin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "opencode"), "#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n", { mode: 0o700 });
  const helpers = join(root, "deploy", "docker");
  await mkdir(helpers, { recursive: true });
  await copyFile(new URL("deploy/docker/credential-install.mjs", repo), join(helpers, "credential-install.mjs"));
  const code = action => `import {runOpenCode} from ${JSON.stringify(new URL("../dev-stack/opencode-wrapper.mjs", import.meta.url).href)}; await runOpenCode(${JSON.stringify(state.directory)}, [${JSON.stringify(action)}]);`;
  const login = await exec(process.execPath, ["--input-type=module", "-e", code("login")]);
  assert.deepEqual(JSON.parse(login.stdout), ["auth", "login", "--standalone"]);
  const imported = exec(process.execPath, ["--input-type=module", "-e", code("credential-install")]);
  imported.child.stdin.end(JSON.stringify({ files: { "auth.json": Buffer.from('{"test":true}').toString("base64") } }));
  assert.equal((await imported).stdout, "IMPORTED\n");
  const target = join(state.directory, "opencode", "data", "opencode", "auth.json");
  assert.equal(await readFile(target, "utf8"), '{"test":true}');
  assert.equal((await stat(target)).mode & 0o777, 0o600);
});

test("down authenticates to the owned controller and waits for cleanup", async t => {
  const root = await fixture(t);
  const state = await prepareState(root, portsFromEnvironment({}));
  let requested = false;
  const close = await startControl(state, () => { requested = true; void close(); });
  const denied = await new Promise((resolve, reject) => {
    const socket = createConnection(state.socket);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify({ action: "down", token: "wrong-token" }) + "\n"));
    socket.once("data", data => { socket.end(); resolve(data.toString().trim()); });
  });
  assert.equal(denied, "denied");
  assert.equal(requested, false);
  await assert.rejects(startControl(state, () => {}), /already running/);
  await requestShutdown(state);
  assert.equal(requested, true);
  await assert.rejects(stat(join(state.directory, "runtime.lock")), { code: "ENOENT" });
});

test("a crashed controller does not authorize killing an unrelated live process", async t => {
  const root = await fixture(t);
  const state = await prepareState(root, portsFromEnvironment({}));
  await writeFile(join(state.directory, "runtime.lock"), String(process.pid));
  await assert.rejects(requestShutdown(state), /supervisor is alive/);
});

test("a partial control startup removes its lock and leaves existing files intact", async t => {
  const root = await fixture(t);
  const state = await prepareState(root, portsFromEnvironment({}));
  const tokenFile = join(state.directory, "secrets", "control-token");
  const token = await readFile(tokenFile, "utf8");
  await rm(tokenFile);
  await assert.rejects(startControl(state, () => {}), { code: "ENOENT" });
  await assert.rejects(stat(join(state.directory, "runtime.lock")), { code: "ENOENT" });
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(state.socket, "existing file");
  await assert.rejects(startControl(state, () => {}), /non-socket/);
  assert.equal(await readFile(state.socket, "utf8"), "existing file");
  await assert.rejects(stat(join(state.directory, "runtime.lock")), { code: "ENOENT" });
});

test("a reset keeps exclusive ownership until its final cleanup and blocks a concurrent up", async t => {
  const root = await fixture(t);
  let finishReset;
  let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const reset = withLifecycleLock(root, async () => {
    acquired();
    await new Promise(resolve => { finishReset = resolve; });
  });
  await ready;
  let started = false;
  await assert.rejects(withLifecycleLock(root, () => { started = true; }), /Another dev:stack operation/);
  assert.equal(started, false);
  finishReset();
  await reset;
  await withLifecycleLock(root, () => { started = true; });
  assert.equal(started, true);
});

test("a stale operation guard is refused without unlinking a possible replacement owner", async t => {
  const root = await fixture(t);
  const lock = join(root, ".dev-stack-operation.lock");
  await mkdir(lock);
  await writeFile(join(lock, "owner.json"), "previous operation");
  const results = await Promise.allSettled([withLifecycleLock(root, () => {}), withLifecycleLock(root, () => {})]);
  assert.ok(results.every(result => result.status === "rejected"));
  assert.equal(await readFile(join(lock, "owner.json"), "utf8"), "previous operation");
});

test("unexpected process exit fails the supervisor and shutdown reaps its other children", async t => {
  const root = await fixture(t);
  const failures = [];
  let output = "";
  const supervisor = new ProcessSupervisor({ cwd: root, env: { PATH: process.env.PATH }, write: text => { output += text; }, onFailure: error => failures.push(error) });
  t.after(() => supervisor.stop());
  const long = supervisor.start("worker", process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"]);
  const short = supervisor.start("api", process.execPath, ["-e", "process.exit(7)"]);
  await assert.rejects(short.completion, /api exited/);
  await waitFor(() => output.includes("[worker] ready"), { timeoutMs: 2000 });
  await supervisor.stop();
  assert.ok(failures.some(error => /api/.test(error.message)));
  assert.throws(() => process.kill(long.pid, 0), { code: "ESRCH" });
});

test("shutdown also terminates a watcher's descendants in the same process group", async t => {
  const root = await fixture(t);
  const pidFile = join(root, "descendant.pid");
  const supervisor = new ProcessSupervisor({ cwd: root, env: { PATH: process.env.PATH }, write: () => {} });
  t.after(() => supervisor.stop());
  supervisor.start("watcher", process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    import { writeFileSync } from 'node:fs';
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    process.once('SIGTERM', () => child.once('exit', () => process.exit(0)));
    setInterval(() => {}, 1000);
  `]);
  await waitFor(() => stat(pidFile).then(() => true, () => false), { timeoutMs: 2000 });
  const descendant = Number(await readFile(pidFile, "utf8"));
  await supervisor.stop();
  assert.throws(() => process.kill(descendant, 0), { code: "ESRCH" });
});

test("a failed watcher cannot leave its child running after its own exit", async t => {
  const root = await fixture(t);
  const stopped = join(root, "child-stopped");
  const supervisor = new ProcessSupervisor({ cwd: root, env: { PATH: process.env.PATH }, write: () => {} });
  t.after(() => supervisor.stop());
  const childCode = `import {writeFileSync} from 'node:fs'; process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)}); console.log('ready'); setInterval(()=>{},1000);`;
  const watcher = supervisor.start("watcher", process.execPath, ["--input-type=module", "-e", `
    import { spawn } from 'node:child_process';
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childCode)}], { stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.once('data', () => process.exit(7));
  `]);
  await assert.rejects(watcher.completion, /watcher exited/);
  await supervisor.stop();
  assert.equal(await readFile(stopped, "utf8"), "stopped");
});

test("readiness timeout and cancellation are visible failures", async () => {
  await assert.rejects(waitFor(() => false, { timeoutMs: 1, description: "worker" }), /worker/);
  const controller = new AbortController();
  controller.abort(new Error("stopped by operator"));
  await assert.rejects(waitFor(() => false, { signal: controller.signal }), /stopped by operator/);
});

test("readiness monitoring tolerates a reload but reports a sustained outage", async () => {
  let calls = 0;
  const controller = new AbortController();
  await assert.rejects(monitorReadiness(async () => {
    calls++;
    return calls === 2;
  }, { signal: controller.signal, intervalMs: 1, failureLimit: 2 }), /readiness failed repeatedly/);
  assert.equal(calls, 4);
  controller.abort();
  await monitorReadiness(async () => false, { signal: controller.signal, intervalMs: 1 });
});
