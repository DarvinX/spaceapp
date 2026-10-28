cripts/dev-stack/opencode-wrapper.mjsimport { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export async function openCodeEnvironment(state) {
  const home = join(state.directory, "opencode");
  return {
    PATH: `${join(state.directory, "vendor", "node_modules", ".bin")}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    HOME: home, TMPDIR: join(state.directory, "tmp"), LANG: process.env.LANG ?? "C.UTF-8", TERM: "xterm-256color",
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_STATE_HOME: join(home, "state"), XDG_CACHE_HOME: join(home, "cache"),
    OPENCODE_DISABLE_AUTOUPDATE: "true", OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: await readFile(join(state.directory, "secrets", "opencode-password"), "utf8")
  };
}

export async function runOpenCode(directory, args) {
  const state = { ...JSON.parse(await readFile(join(directory, "state.json"), "utf8")), directory };
  if (args[0] === "--run-inner") args = args.slice(1);
  const action = args[0];
  const env = await openCodeEnvironment(state);
  const command = join(directory, "vendor", "node_modules", ".bin", "opencode");
  await access(command, constants.X_OK);
  if (["credential-status", "credential-observation", "credential-smoke"].includes(action)) {
    const response = await fetch(`http://127.0.0.1:${state.ports.opencode}/api/info`, {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` },
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) throw new Error("The development OpenCode server is unavailable.");
    const markers = { "credential-status": "READY", "credential-observation": "OBSERVATION:source-development-opencode", "credential-smoke": "SPACE_OPENCODE_OK" };
    process.stdout.write(markers[action] + "\n");
    return;
  }
  // Every pane uses the supervised server, so no detached OpenCode daemon survives down/reset.
  const pane = !args.length || ["--continue", "-c", "--session", "-s"].includes(action);
  let commandArgs = pane
    ? ["--server", `http://127.0.0.1:${state.ports.opencode}`, ...args, process.cwd()]
    : [...args, ...(["--help", "-h", "--version", "-v"].includes(action) ? [] : ["--standalone"])];
  const delegated = ["opencode-text", "opencode-models", "credential-install"].includes(action);
  if (action === "credential-install") {
    commandArgs = [join(state.root, "deploy", "docker", "credential-install.mjs"), "opencode", env.HOME];
  } else if (delegated) {
    commandArgs = [join(state.root, "deploy", "docker", "opencode-standalone.mjs"), action.slice("opencode-".length)];
  } else if (action === "login") {
    commandArgs = ["auth", "login", ...args.slice(1), "--standalone"];
  }
  const child = spawn(delegated ? process.execPath : command, commandArgs, { env, stdio: "inherit" });
  child.once("error", () => { process.stderr.write("OpenCode could not start. Restart dev:stack to reinstall its pinned version.\n"); process.exitCode = 1; });
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => child.kill(signal));
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
