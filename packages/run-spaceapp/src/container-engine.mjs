import { Writable } from "node:stream";

export const PODMAN_MIN_VERSION = "5.0.0";
export const PODMAN_COMPOSE_MIN_VERSION = "2.24.4";

export function containerEngine(value = "docker") {
  if (value !== "docker" && value !== "podman") {
    throw new Error("Container engine must be docker or podman.");
  }
  return value;
}

/** Keep every lifecycle command on the installation's engine, including probes. */
export function engineCommand(spec, engine = "docker") {
  containerEngine(engine);
  if (engine === "docker" || spec.command !== "docker") return spec;
  return {
    ...spec,
    command: "podman",
    ...(spec.args?.[0] === "compose" ? {
      env: { ...spec.env, PODMAN_COMPOSE_PROVIDER: "docker-compose" }
    } : {})
  };
}

async function capture(execute, spec) {
  let output = "";
  const stdout = new Writable({ write(chunk, _encoding, done) {
    if (output.length < 1024 * 1024) output += chunk.toString();
    done();
  } });
  try {
    const code = await execute({ ...spec, timeoutMs: 15000 }, { stdout, stderr: null, stdin: null });
    return code === 0 ? output.trim() : null;
  } catch {
    return null;
  }
}

export async function selectContainerEngine({ requested, existing, execute, platform, choosePodman }) {
  if (requested !== undefined) containerEngine(requested);
  const saved = existing ? containerEngine(existing.engine) : null;
  if (saved && requested && requested !== saved) {
    throw new Error(`This installation uses ${saved}. Switching to ${requested} would hide its volumes. ` +
      "Keep the current engine; use a separate SPACEAPP_HOME for a new installation.");
  }
  if (saved || requested) return saved ?? requested;
  if (platform === "win32") return "docker";
  if (await capture(execute, { command: "docker", args: ["info"] }) !== null) return "docker";
  const podmanVersion = await capture(execute, { command: "podman", args: ["--version"] });
  if (/podman version \d+\.\d+/i.test(podmanVersion ?? "")) {
    return !choosePodman || await choosePodman() ? "podman" : "docker";
  }
  return "docker";
}

export function parseEngineInfo(engine, raw) {
  containerEngine(engine);
  if (engine === "podman") {
    const host = raw?.host ?? {};
    const controllers = Array.isArray(host.cgroupControllers) ? host.cgroupControllers : [];
    return {
      engine,
      version: raw?.version?.Version ?? null,
      rootless: host.security?.rootless === true,
      cgroupVersion: host.cgroupVersion ?? null,
      cpuLimits: controllers.includes("cpu"),
      memoryLimits: controllers.includes("memory"),
      cpuCount: host.cpus ?? null,
      memoryBytes: host.memTotal ?? null,
      storageRoot: raw?.store?.graphRoot ?? null,
      storageAllocatedBytes: raw?.store?.graphRootAllocated ?? null,
      storageUsedBytes: raw?.store?.graphRootUsed ?? null,
      architecture: host.arch ?? null
    };
  }
  return {
    engine,
    version: raw?.ServerVersion ?? null,
    rootless: (raw?.SecurityOptions ?? []).some((option) => String(option).includes("rootless")),
    cgroupVersion: raw?.CgroupVersion ?? null,
    cpuLimits: raw?.CpuCfsQuota === true,
    memoryLimits: raw?.MemoryLimit === true,
    cpuCount: raw?.NCPU ?? null,
    memoryBytes: raw?.MemTotal ?? null,
    storageRoot: raw?.DockerRootDir ?? null,
    architecture: raw?.Architecture ?? null
  };
}

export async function inspectContainerEngine(execute, engine = "docker") {
  const args = engine === "podman" ? ["info", "--format", "json"] : ["info", "--format", "{{json .}}"];
  const output = await capture(execute, { command: containerEngine(engine), args });
  if (!output) return null;
  try {
    const raw = JSON.parse(output);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    if (engine === "podman" && !raw.host) return null;
    return parseEngineInfo(engine, raw);
  } catch {
    return null;
  }
}

function atLeast(value, minimum) {
  const match = /(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/.exec(value ?? "");
  if (!match) return false;
  const actual = match.slice(1).map(Number);
  const required = minimum.split(".").map(Number);
  for (let index = 0; index < required.length; index++) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

export function podmanCompatibilityChecks(info, composeVersion, { platform = process.platform, profileRequirements } = {}) {
  const checks = [
    { name: "Podman version", ok: atLeast(info?.version, PODMAN_MIN_VERSION),
      detail: `${info?.version ?? "unavailable"}; requires Podman >= ${PODMAN_MIN_VERSION}` },
    { name: "Podman Compose provider", ok: atLeast(composeVersion, PODMAN_COMPOSE_MIN_VERSION),
      detail: `docker-compose ${composeVersion ?? "unavailable"}; requires v${PODMAN_COMPOSE_MIN_VERSION} or later` },
    { name: "Podman rootless", ok: info?.rootless === true, detail: info?.rootless ? "rootless" : "rootful or unavailable; use your unprivileged user's Podman connection" },
    { name: "Podman cgroups", ok: info?.cgroupVersion === "v2", detail: info?.cgroupVersion ?? "unavailable; cgroup v2 is required" },
    { name: "Podman CPU limits", ok: info?.cpuLimits === true, detail: info?.cpuLimits ? "cpu controller delegated" : "cpu controller is not delegated; enable systemd user-session delegation" },
    { name: "Podman memory limits", ok: info?.memoryLimits === true, detail: info?.memoryLimits ? "memory controller delegated" : "memory controller is not delegated; enable systemd user-session delegation" }
  ];
  if (platform === "darwin" && profileRequirements) {
    checks.push(
      { name: "Podman machine CPU", ok: info?.cpuCount >= profileRequirements.cpuCount,
        detail: `${info?.cpuCount ?? 0} CPUs; requires ${profileRequirements.cpuCount}. Resize with podman machine stop and podman machine set --cpus.` },
      { name: "Podman machine memory", ok: info?.memoryBytes >= profileRequirements.memoryBytes,
        detail: `${Math.floor((info?.memoryBytes ?? 0) / 1024 ** 2)} MiB; requires ${Math.ceil(profileRequirements.memoryBytes / 1024 ** 2)} MiB. Resize with podman machine set --memory.` },
      { name: "Podman machine disk", ok: info?.storageAllocatedBytes - info?.storageUsedBytes >= profileRequirements.freshDiskBytes,
        detail: `Requires ${Math.ceil(profileRequirements.freshDiskBytes / 1024 ** 3)} GiB free inside the machine. Resize with podman machine set --disk-size.` }
    );
  }
  return checks;
}

export async function inspectPodmanCompatibility(execute, options = {}) {
  const info = await inspectContainerEngine(execute, "podman");
  const version = await capture(execute, engineCommand({ command: "docker", args: ["compose", "version", "--short"] }, "podman"));
  return { info, checks: podmanCompatibilityChecks(info, version, options) };
}

export async function ensurePodmanAvailable({ execute, platform, stdout, stderr, profileRequirements }) {
  if (platform !== "linux" && platform !== "darwin") {
    stderr.write("Podman is supported on Linux and macOS only.\n");
    return { code: 1 };
  }
  const { checks } = await inspectPodmanCompatibility(execute, { platform, profileRequirements });
  for (const check of checks) {
    (check.ok ? stdout : stderr).write(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}\n`);
  }
  if (checks.some((check) => !check.ok)) {
    stderr.write("Install Podman >= 5 and the docker-compose v2 provider. On macOS, start a rootless Podman machine first. SpaceApp does not install or reconfigure Podman.\n");
    return { code: 1 };
  }
  return { code: 0 };
}

/** Share SELinux labels across services; never change the host workspace's owner. */
export function podmanComposeOverrides() {
  const serviceSecrets = {
    "spaceapp-core": ["setup-token", "session-secret", "database-url"],
    "spaceapp-browser": ["database-url"],
    postgres: ["postgres-password"],
    temporal: ["postgres-password"]
  };
  const mappedServices = ["spaceapp-core", "spaceapp-cli", "spaceapp-browser", "codex-sessions-init"];
  const services = [...new Set([...mappedServices, ...Object.keys(serviceSecrets)])];
  return ["services:", ...services.flatMap((service) => [
    `  ${service}:`,
    ...(mappedServices.includes(service) ? [
      '    userns_mode: "keep-id:uid=10001,gid=10001"',
      '    user: "0:0"'
    ] : []),
    ...(serviceSecrets[service] ? [
      "    secrets: !reset []",
      "    volumes:",
      ...serviceSecrets[service].flatMap((secret) => [
        "      - type: bind",
        `        source: ./secrets/${secret}`,
        `        target: /run/secrets/${secret}`,
        "        read_only: true",
        "        bind:",
        "          selinux: z",
        "          create_host_path: false"
      ])
    ] : [])
  ]), ""].join("\n");
}
