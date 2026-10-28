import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import {
  containerEngine,
  engineCommand,
  parseEngineInfo,
  podmanCompatibilityChecks,
  selectContainerEngine
} from "../src/container-engine.mjs";
import { run } from "../src/cli.mjs";
import {
  composeCommand,
  createDefaultConfig,
  initializeInstallation,
  prepareInstallation,
  renderHostAccessCompose,
  renderWorkspaceCompose,
  validateConfig
} from "../src/index.mjs";

const gib = 1024 ** 3;
const podmanInfo = {
  version: { Version: "5.4.2" },
  host: { arch: "amd64", cpus: 8, memTotal: 16 * gib, cgroupVersion: "v2",
    cgroupControllers: ["cpu", "memory", "pids"], security: { rootless: true } },
  store: { graphRootAllocated: 80 * gib, graphRootUsed: 20 * gib }
};

function capture() {
  let output = "";
  const stream = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
  return { stream, text: () => output };
}

async function fixture(t, engine = "podman") {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = capture();
  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root, SPACEAPP_TELEMETRY: "0" },
    platform: "linux",
    stdin: Readable.from([]), stdout: output.stream, stderr: output.stream,
    prepareDockerPath: async () => {},
    inspectResources: async () => ({ cpuCount: 8, totalMemoryBytes: 16 * gib, freeDiskBytes: 30 * gib }),
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "docker") return 127;
      if (spec.args[0] === "--version") {
        io.stdout?.write("podman version 5.4.2");
        return 0;
      }
      if (spec.args[0] === "info") io.stdout?.write(JSON.stringify(podmanInfo));
      if (spec.args.includes("version")) io.stdout?.write("2.39.4");
      return 0;
    },
    request: async (url) => ({ ok: true, status: 200,
      json: async () => url.endsWith("/readyz") ? { ok: true } : { setupRequired: true, expiresAt: null } }),
    sleep: async () => {}
  };
  if (engine) await initializeInstallation(root, { version: "0.1.10", profile: "small", engine });
  return { root, options, calls, output };
}

test("engine values are a fixed allowlist and Docker commands remain unchanged", () => {
  assert.equal(containerEngine(), "docker");
  assert.throws(() => containerEngine("podman; rm -rf /"), /must be docker or podman/);
  const spec = { command: "docker", args: ["info"] };
  assert.equal(engineCommand(spec, "docker"), spec);
  assert.deepEqual(engineCommand(spec, "podman"), { command: "podman", args: ["info"] });
  assert.deepEqual(engineCommand({ command: "open", args: ["http://127.0.0.1"] }, "podman"),
    { command: "open", args: ["http://127.0.0.1"] });
});

test("all Compose profiles and lifecycle actions retain arguments on Podman", () => {
  const actions = ["up", "down", "status", "logs", "pull", "repair", "backup", "purge", "checkpointDump",
    "checkpointRestore", "ensureCheckpointDatabase", "syncWorkspaces", "syncCredentials", "rotateOwnerSetupToken",
    "resetOwnerPassword", "exportCliSettings", "importCliSettings", "cliHostReady"];
  for (const profile of ["small", "medium", "large"]) {
    for (const action of actions) {
      const docker = composeCommand(action, "/tmp/spaceapp", { profile });
      const podman = composeCommand(action, "/tmp/spaceapp", { profile, engine: "podman" });
      assert.equal(podman.command, "podman");
      assert.deepEqual(podman.args, docker.args);
      assert.deepEqual(podman.env, { PODMAN_COMPOSE_PROVIDER: "docker-compose" });
    }
  }
  assert.ok(composeCommand("installProvider", "/tmp/spaceapp", { engine: "podman", provider: "opencode" }).args.includes("10001:10001"));
});

test("automatic detection prefers working Docker and offers an installed Podman CLI", async () => {
  const execute = (dockerWorks) => async (spec, io) => {
    if (spec.command === "docker") return dockerWorks ? 0 : 127;
    io.stdout.write("podman version 5.4.2");
    return 0;
  };
  assert.equal(await selectContainerEngine({ execute: execute(true), platform: "linux" }), "docker");
  assert.equal(await selectContainerEngine({ execute: execute(false), platform: "linux" }), "podman");
  assert.equal(await selectContainerEngine({ execute: execute(false), platform: "linux", choosePodman: async () => false }), "docker");
  assert.equal(await selectContainerEngine({ execute: async () => 0, platform: "linux", requested: "podman" }), "podman");
  assert.equal(await selectContainerEngine({ execute: async () => 127, platform: "linux" }), "docker");
});

test("engine switches and host-root Podman configurations are rejected", async (t) => {
  const f = await fixture(t);
  await assert.rejects(selectContainerEngine({ existing: { engine: "podman" }, requested: "docker" }), /hide its volumes/);
  await assert.rejects(prepareInstallation(f.root, { version: "0.1.10", engine: "docker" }), /hide the existing volumes/);
  assert.throws(() => validateConfig({ ...createDefaultConfig({ version: "0.1.10" }), engine: "podman", accessMode: "host-root" }), /Host-root access/);
});

test("Podman diagnostics reject old versions, rootful engines and undelegated limits", () => {
  const info = parseEngineInfo("podman", podmanInfo);
  assert.ok(podmanCompatibilityChecks(info, "2.39.4").every((check) => check.ok));
  const unsupported = { ...info, version: "4.9.3", rootless: false, cgroupVersion: "v1", cpuLimits: false, memoryLimits: false };
  assert.deepEqual(podmanCompatibilityChecks(unsupported, "1.29.2").map((check) => check.ok), Array(6).fill(false));
  const mac = podmanCompatibilityChecks({ ...info, cpuCount: 1, memoryBytes: gib, storageAllocatedBytes: gib }, "2.39.4",
    { platform: "darwin", profileRequirements: { cpuCount: 4, memoryBytes: 7 * gib, freshDiskBytes: 7 * gib } });
  assert.ok(mac.slice(-3).every((check) => !check.ok));
  assert.match(mac.at(-1).detail, /podman machine set/);
});

test("Podman mounts share SELinux labels and map host files to UID 10001 without chown", () => {
  const config = createDefaultConfig({ version: "0.1.10", engine: "podman" });
  config.workspaces.push({ id: "work-12345678", name: "work", hostPath: "/tmp/my work", containerPath: "/workspaces/work", readOnly: true });
  const workspaces = renderWorkspaceCompose(config);
  assert.match(workspaces, /source: "\/tmp\/my work"/);
  assert.match(workspaces, /read_only: true\n\s+bind:\n\s+selinux: z/);
  const overrides = renderHostAccessCompose(config);
  assert.match(overrides, /keep-id:uid=10001,gid=10001/);
  assert.match(overrides, /secrets: !reset \[\]/);
  assert.match(overrides, /target: \/run\/secrets\/database-url/);
  assert.doesNotMatch(overrides, /label=disable|chown|:U/);
});

test("saved Podman engine dispatches lifecycle, doctor and support probes without Docker", async (t) => {
  const f = await fixture(t);
  for (const command of ["status", "up", "logs", "down", "doctor", "support-bundle"]) {
    assert.equal(await run([command], f.options), 0, command);
  }
  assert.ok(f.calls.length > 0);
  assert.ok(f.calls.every((call) => call.command === "podman"));
  assert.match(f.output.text(), /PASS Podman rootless: rootless/);
  const bundleName = f.output.text().match(/support-bundle-[^\s]+\.json/)[0];
  const bundle = JSON.parse(await readFile(join(f.root, bundleName), "utf8"));
  assert.deepEqual(bundle.containerEngine, { engine: "podman", version: "5.4.2", rootless: true, cgroupVersion: "v2", cpuLimits: true, memoryLimits: true });
});

test("unattended install accepts engine through answers and saves it", async (t) => {
  const f = await fixture(t, null);
  const args = ["install", "--non-interactive", "--answers",
    JSON.stringify({ confirm: true, profile: "small", engine: "podman", access: "isolated", companions: false, telemetry: false, open: false })];
  assert.equal(await run(args, f.options), 0);
  const config = JSON.parse(await readFile(join(f.root, "config.json"), "utf8"));
  assert.equal(config.engine, "podman");
  assert.ok(f.calls.every((call) => call.command === "podman"));
  assert.match(await readFile(join(f.root, "compose.yml"), "utf8"), /\.\/backups:\/backups:z/);
});

test("automatic Podman fallback never starts Docker installation", async (t) => {
  const f = await fixture(t, null);
  assert.equal(await run(["install", "--non-interactive", "--answers",
    '{"confirm":true,"profile":"small","open":false}'], f.options), 0);
  assert.equal(JSON.parse(await readFile(join(f.root, "config.json"), "utf8")).engine, "podman");
  assert.ok(!f.calls.some((call) => ["sudo", "sg"].includes(call.command)));
  assert.ok(f.calls.some((call) => call.command === "podman" && call.args.includes("up")));
});

test("factory reset keeps the chosen engine for the new installation", async (t) => {
  const f = await fixture(t);
  f.options.stdin = Readable.from(["FACTORY-RESET\n"]);
  assert.equal(await run(["factory-reset"], f.options), 0);
  assert.equal(JSON.parse(await readFile(join(f.root, "config.json"), "utf8")).engine, "podman");
  assert.ok(f.calls.every((call) => call.command === "podman"));
});

test("Podman workspace registration does not suggest Docker's host UID workaround", async (t) => {
  const f = await fixture(t);
  const workspace = join(f.root, "project");
  await mkdir(workspace);
  assert.equal(await run(["workspace", "add", workspace], f.options), 0);
  assert.doesNotMatch(f.output.text(), /setfacl/);
  assert.match(await readFile(join(f.root, "compose.workspaces.yml"), "utf8"), /selinux: z/);
  assert.ok(f.calls.every((call) => call.command === "podman"));
});

test("a missing saved Podman engine is diagnosed without Docker installation advice", async (t) => {
  const f = await fixture(t);
  f.options.execute = async () => 127;
  assert.equal(await run(["status"], f.options), 127);
  assert.match(f.output.text(), /could not find the Podman CLI/);
  assert.doesNotMatch(f.output.text(), /could not find the Docker CLI/);
});
