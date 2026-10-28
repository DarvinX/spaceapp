import { createHash, randomBytes } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { constants } from "node:fs";

const portDefaults = { api: 5910, web: 5911, postgres: 55432, temporal: 57233, opencode: 5799 };
const stateVersion = 1;

export function portsFromEnvironment(env = process.env) {
  const ports = Object.fromEntries(Object.entries(portDefaults).map(([name, fallback]) => {
    const value = env[`SPACE_DEV_${name.toUpperCase()}_PORT`] ?? String(fallback);
    if (!/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) {
      throw new Error(`SPACE_DEV_${name.toUpperCase()}_PORT must be a port between 1024 and 65535.`);
    }
    return [name, Number(value)];
  }));
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
    throw new Error("Development stack ports must be different from each other.");
  }
  if (Object.values(ports).some(port => port === 4910 || port === 4911)) {
    throw new Error("Development stack ports must not use the installed application's ports 4910/4911.");
  }
  return ports;
}

export function projectName(root) {
  return `spaceapp-dev-${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 12)}`;
}

export function dependencyImage(template, service) {
  const block = template.match(new RegExp(`^  ${service}:\\s*\\n((?:^    .*\\n|^\\s*\\n)*)`, "m"))?.[1];
  const image = block?.match(/^ {4}image: ([^\s]+)\s*$/m)?.[1];
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image) || image.includes("${")) {
    throw new Error(`The launcher must pin a literal digest for ${service}.`);
  }
  return image;
}

export function openCodePackage(dockerfile) {
  const pinned = dockerfile.match(/(?:@opencode\/cli|opencode-ai)@\d+\.\d+\.\d+(?:-[\w.-]+)?/g);
  if (!pinned || new Set(pinned).size !== 1) throw new Error("Expected one pinned OpenCode package in Dockerfile.");
  return pinned[0];
}

export async function privateFile(path, contents) {
  try {
    await writeFile(path, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid()) {
    throw new Error(`Refusing to use an unsafe development state file: ${path}`);
  }
  await chmod(path, 0o600);
  return readFile(path, "utf8");
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new Error(`Refusing to use an unsafe development state directory: ${path}`);
  }
  await chmod(path, 0o700);
}

export async function loadState(root) {
  const directory = join(resolve(root), ".dev-stack");
  const info = await lstat(directory).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
    throw new Error(".dev-stack must be an owned directory, not a symlink.");
  }
  const settings = JSON.parse(await readFile(join(directory, "state.json"), "utf8"));
  if (settings.version !== stateVersion || settings.root !== resolve(root) || settings.project !== projectName(root)) {
    throw new Error("Refusing to manage .dev-stack: its ownership marker does not match this checkout.");
  }
  portsFromEnvironment(Object.fromEntries(Object.entries(settings.ports).map(([key, value]) =>
    [`SPACE_DEV_${key.toUpperCase()}_PORT`, String(value)])));
  return { ...settings, directory, composeFile: join(directory, "compose.json"), socket: join(directory, "control.sock") };
}

export async function prepareState(root, ports) {
  root = resolve(root);
  const directory = join(root, ".dev-stack");
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "state.json"), JSON.stringify({
      version: stateVersion, root, project: projectName(root), ports
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const state = await loadState(root);
  if (JSON.stringify(state.ports) !== JSON.stringify(ports)) {
    throw new Error("Ports differ from this checkout's saved stack. Run dev:stack -- reset before changing ports.");
  }
  if (Buffer.byteLength(state.socket) > 100) throw new Error("Clone into a shorter path: the development Unix socket path exceeds 100 bytes.");
  await chmod(directory, 0o700);
  for (const name of ["secrets", "memory", "memory-graph", "artifacts", "workspaces", "providers", "opencode", "wrappers", "vendor", "tmp"]) {
    await privateDirectory(join(directory, name));
  }
  for (const name of ["postgres-password", "session-secret", "setup-token", "control-token", "opencode-password"]) {
    await privateFile(join(directory, "secrets", name), randomBytes(32).toString("hex"));
  }
  for (const name of ["space_memory.md", "space_memory_monthly.md", "installation-guide.md"]) {
    await copyFile(join(root, "starter-memory", name), join(directory, "memory", name), constants.COPYFILE_EXCL).catch(error => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  return state;
}

export function dockerEnvironment(inherited = process.env) {
  const allowed = ["PATH", "HOME", "LANG", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];
  return Object.fromEntries(allowed.filter(key => inherited[key] !== undefined).map(key => [key, inherited[key]]));
}

export function dependencyCompose(state, images) {
  const { ports } = state;
  const common = { restart: "no", security_opt: ["no-new-privileges:true"] };
  return {
    services: {
      postgres: {
        ...common, image: images.postgres,
        environment: { POSTGRES_DB: "spaceapp_dev", POSTGRES_USER: "spaceapp", POSTGRES_PASSWORD_FILE: "/run/secrets/postgres-password" },
        secrets: ["postgres-password"], volumes: ["postgres:/var/lib/postgresql/data"],
        ports: [`127.0.0.1:${ports.postgres}:5432`],
        healthcheck: { test: ["CMD-SHELL", "pg_isready -U spaceapp -d spaceapp_dev"], interval: "2s", timeout: "5s", retries: 60 }
      },
      temporal: {
        ...common, image: images.temporal,
        environment: { DB: "postgres12", DB_PORT: "5432", POSTGRES_USER: "spaceapp", POSTGRES_SEEDS: "postgres", DYNAMIC_CONFIG_FILE_PATH: "config/dynamicconfig/docker.yaml" },
        entrypoint: ["/bin/sh", "-ec"],
        command: ["export POSTGRES_PWD=\"$$(cat /run/secrets/postgres-password)\"; exec /etc/temporal/entrypoint.sh autosetup"],
        secrets: ["postgres-password"], ports: [`127.0.0.1:${ports.temporal}:7233`],
        depends_on: { postgres: { condition: "service_healthy" } },
        healthcheck: { test: ["CMD-SHELL", "temporal operator cluster health --address temporal:7233 >/dev/null && temporal operator namespace describe --namespace default --address temporal:7233 >/dev/null"], interval: "3s", timeout: "10s", retries: 60 }
      }
    },
    secrets: { "postgres-password": { file: "./secrets/postgres-password" } },
    volumes: { postgres: {} }
  };
}

export async function sourceEnvironment(state, inherited = process.env) {
  const { directory, root, ports } = state;
  const secret = name => readFile(join(directory, "secrets", name), "utf8");
  const env = {
    PATH: inherited.PATH ?? "/usr/local/bin:/usr/bin:/bin", LANG: inherited.LANG ?? "C.UTF-8", TERM: inherited.TERM ?? "xterm-256color",
    NODE_ENV: "development", ELECTRON_SKIP_BINARY_DOWNLOAD: "1", HOME: join(directory, "providers"), TMPDIR: join(directory, "tmp"),
    SPACE_INSTANCE: "dev", SPACE_INSTANCE_ENABLED_JOBS: "", SPACE_PUBLIC_DISTRIBUTION: "true",
    SPACE_DEV_LOGIN: "false", SPACE_AGENT_TOOLS_WRITER: "disabled", SPACE_TELEMETRY_ENABLED: "false",
    SPACE_API_HOST: "127.0.0.1", SPACE_API_PORT: String(ports.api), SPACE_WEB_HOST: "127.0.0.1", SPACE_WEB_PORT: String(ports.web),
    SPACE_API_ORIGIN: `http://127.0.0.1:${ports.api}`, SPACEAPP_WORKFLOWS_ENABLED: "true",
    SPACE_PUBLIC_ORIGIN: `http://127.0.0.1:${ports.web}`, SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN: `http://127.0.0.1:${ports.web}`,
    SPACE_CHESS_MOVE_SOCKET: "disabled",
    SPACE_RUNTIME_STORE: "postgres", SPACE_DATABASE_URL: `postgresql://spaceapp:${await secret("postgres-password")}@127.0.0.1:${ports.postgres}/spaceapp_dev`,
    SPACE_SESSION_SECRET: await secret("session-secret"), SPACE_SETUP_TOKEN_FILE: join(directory, "secrets", "setup-token"),
    SPACE_TEMPORAL_ADDRESS: `127.0.0.1:${ports.temporal}`, SPACE_TEMPORAL_NAMESPACE: "spaceapp-dev", SPACE_TEMPORAL_TASK_QUEUE: "spaceapp-dev-turns",
    SPACE_CLI_ENABLED: "true", SPACE_CLI_ROOT_ENABLED: "false", SPACE_CLI_COMMAND_PATH: join(directory, "wrappers"),
    SPACE_CLI_OPENCODE_COMMAND: "opencode-vscode-parity", SPACE_CLI_HOST_SOCKET: join(directory, "cli.sock"),
    SPACE_CLI_ADMIN_HOST_SOCKET: join(directory, "disabled-admin.sock"), SPACE_CLI_WORKSPACE_ROOT: join(directory, "workspaces"),
    SPACE_WORKSPACE_ROOT: join(directory, "workspaces"), SPACE_INSTALL_ROOT: root,
    SPACE_CODEX_APP_SERVER_HOME: join(directory, "providers"), SPACE_CODEX_HOME: join(directory, "providers", "codex"),
    SPACE_BROWSER_SESSIONS_ENABLED: "false", SPACE_BROWSER_HOST_SOCKET: join(directory, "disabled-browser.sock"),
    SPACE_MEMORY_ROOT: join(directory, "memory"), SPACE_MEMORY_GRAPH_ROOT: join(directory, "memory-graph"),
    SPACE_MEMORY_INDEX_PATH: join(directory, "memory", "space_memory.md"), SPACE_MEMORY_MONTHLY_PATH: join(directory, "memory", "space_memory_monthly.md"),
    SPACE_MEMORY_LOCK_PATH: join(directory, "memory", ".memory.lock"), SPACE_STARTER_MEMORY_ROOT: join(root, "starter-memory"),
    SPACE_ARTIFACT_ROOT: join(directory, "artifacts"), SPACE_PROJECTS_ROOT: join(directory, "workspaces"),
    SPACE_DEMO_PROJECTS_ROOT: join(root, "demos"), SPACE_DEMO_PROJECTS_VAR_ROOT: join(directory, "demo-projects"),
    SPACE_TELEGRAM_SECRET_ROOT: join(directory, "telegram"), SPACE_STREAMING_SECRET_ROOT: join(directory, "streaming"),
    SPACE_TELEGRAM_OWNERSHIP_MANIFEST: join(directory, "telegram", "ownership.json"),
    SPACE_CONNECTOR_KEY_FILE: join(directory, "secrets", "connector.key"), SPACE_DESIGN_GATEWAY_KEY_FILE: join(directory, "secrets", "design.key"),
    SPACE_APP_DIAGNOSTICS_ROOT: join(directory, "diagnostics"), SPACE_MAINTENANCE_AUTOPILOT_STATE_FILE: join(directory, "maintenance", "state.json"),
    SPACE_CODEX_GOALS_DB_PATH: join(directory, "codex-goals.sqlite"), SPACE_CLI_ACCOUNT_BALANCER_STATE_FILE: join(directory, "account-balancer", "state.json"),
    SPACE_VIDEO_TOOLS_DIR: join(directory, "video-tools"), SPACE_DOT_WORKSPACE_ROOT: join(directory, "dot")
  };
  return env;
}
