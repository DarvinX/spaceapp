import { access, chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyCompose, dependencyImage, dockerEnvironment, loadState, openCodePackage, portsFromEnvironment, prepareState, sourceEnvironment } from "./dev-stack/config.mjs";
import { requestShutdown, startControl } from "./dev-stack/control.mjs";
import { withLifecycleLock } from "./dev-stack/lifecycle.mjs";
import { openCodeEnvironment } from "./dev-stack/opencode-wrapper.mjs";
import { monitorReadiness, ProcessSupervisor, waitFor } from "./dev-stack/processes.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = "npm";
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

function composeArgs(state, args) {
  return ["compose", "--project-name", state.project, "--file", state.composeFile, ...args];
}

async function docker(state, args) {
  const runner = new ProcessSupervisor({ cwd: root, env: dockerEnvironment() });
  await runner.run("docker", "docker", composeArgs(state, args));
}

async function stopStack(state, reset) {
  if (!state) { process.stdout.write("This checkout has no development stack.\n"); return; }
  await requestShutdown(state);
  await docker(state, ["down", "--remove-orphans", ...(reset ? ["--volumes"] : [])]);
  if (reset) {
    // The fixed location and verified marker keep reset away from installed state and other checkouts.
    await loadState(root);
    await rm(state.directory, { recursive: true });
  }
  process.stdout.write(reset ? "Development stack state removed.\n" : "Development stack stopped; data retained.\n");
}

async function startStack() {
  await access(join(root, "node_modules", ".bin", "tsx")).catch(() => {
    throw new Error("Install this checkout's locked dependencies first: ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci");
  });
  const abort = new AbortController();
  const requestedStop = () => abort.abort();
  let state;
  let env;
  let controlClose;
  try {
    await withLifecycleLock(root, async () => {
      state = await prepareState(root, portsFromEnvironment());
      env = await sourceEnvironment(state);
      controlClose = await startControl(state, requestedStop);
    });
  } catch (error) {
    await controlClose?.();
    throw error;
  }
  let failure;
  let readinessMonitor;
  let dependenciesStarted = false;
  const processes = new ProcessSupervisor({ cwd: root, env, onFailure: error => {
    if (abort.signal.aborted) return;
    failure = error;
    abort.abort();
  } });
  const stopProcesses = () => { void processes.stop(); };
  abort.signal.addEventListener("abort", stopProcesses, { once: true });
  process.once("SIGINT", requestedStop);
  process.once("SIGTERM", requestedStop);
  try {
    const launcherTemplate = await readFile(join(root, "packages/run-spaceapp/templates/compose.yml"), "utf8");
    const images = Object.fromEntries(["postgres", "temporal"].map(name => [name, dependencyImage(launcherTemplate, name)]));
    await writeFile(state.composeFile, JSON.stringify(dependencyCompose(state, images), null, 2) + "\n", { mode: 0o600 });
    const dockerOptions = { env: dockerEnvironment() };
    await processes.run("docker", "docker", ["compose", "version"], dockerOptions);
    abort.signal.throwIfAborted();
    dependenciesStarted = true;
    await processes.run("docker", "docker", composeArgs(state, ["up", "--detach", "--wait", "--wait-timeout", "240"]), dockerOptions);
    const namespaceArgs = ["exec", "-T", "temporal", "temporal", "operator", "namespace"];
    try {
      await processes.run("temporal", "docker", composeArgs(state, [...namespaceArgs, "describe", "--namespace", env.SPACE_TEMPORAL_NAMESPACE, "--address", "temporal:7233"]), dockerOptions);
    } catch {
      abort.signal.throwIfAborted();
      await processes.run("temporal", "docker", composeArgs(state, [...namespaceArgs, "create", "--namespace", env.SPACE_TEMPORAL_NAMESPACE, "--address", "temporal:7233"]), dockerOptions);
    }
    await processes.run("build", npm, ["run", "build"]);
    await processes.run("migrations", npm, ["run", "db:migrate"]);
    const pinnedPackage = openCodePackage(await readFile(join(root, "Dockerfile"), "utf8"));
    const installed = await readFile(join(state.directory, "vendor", "node_modules", pinnedPackage.split("@").slice(0, -1).join("@"), "package.json"), "utf8")
      .then(text => JSON.parse(text).version, () => null);
    if (installed !== pinnedPackage.split("@").at(-1)) {
      await processes.run("opencode-install", npm, ["install", "--prefix", join(state.directory, "vendor"), "--no-audit", "--no-fund", "--save-exact", pinnedPackage]);
    }
    const wrapper = `#!/bin/sh\nexec ${quote(process.execPath)} --input-type=module -e ${quote(`import { runOpenCode } from ${JSON.stringify(new URL("./dev-stack/opencode-wrapper.mjs", import.meta.url).href)}; await runOpenCode(${JSON.stringify(state.directory)}, process.argv.slice(1));`)} -- "$@"\n`;
    await writeFile(join(state.directory, "wrappers", "opencode-vscode-parity"), wrapper, { mode: 0o700 });
    await chmod(join(state.directory, "wrappers", "opencode-vscode-parity"), 0o700);
    const openCodeEnv = await openCodeEnvironment(state);
    processes.start("opencode", join(state.directory, "vendor", "node_modules", ".bin", "opencode"), ["serve", "--hostname", "127.0.0.1", "--port", String(state.ports.opencode)], {
      env: openCodeEnv, cwd: join(state.directory, "opencode")
    });
    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${state.ports.opencode}/api/info`, {
          headers: { authorization: `Basic ${Buffer.from(`opencode:${openCodeEnv.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` },
          signal: AbortSignal.timeout(2000)
        });
        return response.ok;
      } catch { return false; }
    }, { signal: abort.signal, description: "OpenCode" });
    processes.start("credentials", process.execPath, [join(root, "scripts", "dev-stack", "credential-agent.mjs"), state.directory]);
    await waitFor(() => lstat(join(state.directory, "credentials.sock")).then(info => info.isSocket(), () => false), {
      signal: abort.signal, description: "the development credential agent"
    });
    const tsx = join(root, "node_modules", ".bin", "tsx");
    for (const [name, source] of [["cli-host", "packages/cli-host/src/main.ts"], ["worker", "apps/worker/dist/worker.js"], ["api", "apps/api/src/server.ts"]]) {
      processes.start(name, tsx, ["watch", "--include", "packages/**/dist/**", source]);
    }
    // Call Vite directly: the existing dev:web script explicitly binds 0.0.0.0.
    processes.start("web", join(root, "node_modules", ".bin", "vite"), ["--host", "127.0.0.1", "--port", String(state.ports.web), "--strictPort"], { cwd: join(root, "apps", "web") });
    const stackReady = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${state.ports.web}/readyz`, { signal: AbortSignal.timeout(2000) });
        return response.ok && (await response.json()).ok === true;
      } catch { return false; }
    };
    await waitFor(stackReady, { signal: abort.signal, description: "API, web, database and Temporal worker readiness" });
    readinessMonitor = monitorReadiness(stackReady, { signal: abort.signal }).catch(error => {
      if (abort.signal.aborted) return;
      failure = error;
      abort.abort();
    });
    const statusResponse = await fetch(`http://127.0.0.1:${state.ports.api}/api/setup/status`);
    if (!statusResponse.ok) throw new Error("The owner setup status is unavailable.");
    const status = await statusResponse.json();
    process.stdout.write(`\nSpaceApp source stack: http://127.0.0.1:${state.ports.web}\n`);
    if (status.setupRequired) {
      const token = await readFile(join(state.directory, "secrets", "setup-token"), "utf8");
      process.stdout.write(`One-time owner setup token: ${token}\n`);
    }
    process.stdout.write("Browser service and companion services are disabled.\nEdit API/web sources for hot reload. After a packages/* change, run npm run dev:stack -- rebuild.\nStop with Ctrl+C or npm run dev:stack -- down.\n");
    if (!abort.signal.aborted) await new Promise(resolve => abort.signal.addEventListener("abort", resolve, { once: true }));
  } catch (error) {
    if (!abort.signal.aborted) failure = error;
  } finally {
    process.off("SIGINT", requestedStop);
    process.off("SIGTERM", requestedStop);
    abort.signal.removeEventListener("abort", stopProcesses);
    abort.abort();
    await readinessMonitor;
    await processes.stop();
    try {
      if (dependenciesStarted) await docker(state, ["down", "--remove-orphans"]);
    } finally {
      await controlClose();
    }
  }
  if (failure) throw failure;
}

export async function main(args = process.argv.slice(2)) {
  if (process.platform === "win32") throw new Error("Run dev:stack inside WSL2 on Windows, with Docker integration enabled.");
  const command = args[0] ?? "up";
  if (args.length > 1 || !["up", "down", "reset", "rebuild"].includes(command)) {
    throw new Error("Usage: npm run dev:stack -- [up|down|reset|rebuild]");
  }
  if (command === "up") return startStack();
  if (command === "rebuild") {
    return withLifecycleLock(root, async () => {
      const state = await loadState(root);
      if (!state) throw new Error("Start dev:stack before rebuilding its packages.");
      const runner = new ProcessSupervisor({ cwd: root, env: await sourceEnvironment(state) });
      await runner.run("build", npm, ["run", "build"]);
    });
  }
  return withLifecycleLock(root, async () => stopStack(await loadState(root), command === "reset"));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`Development stack failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
