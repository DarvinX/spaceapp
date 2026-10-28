import { createConnection, createServer } from "node:net";
import { chmod, lstat, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function running(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

export async function startControl(state, requestStop) {
  const lock = join(state.directory, "runtime.lock");
  try {
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(await readFile(lock, "utf8"));
    if (running(pid)) throw new Error("This checkout's development stack is already running. Use dev:stack -- down first.", { cause: error });
    await rm(lock);
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  let server;
  let ownsSocket = false;
  try {
    const token = await readFile(join(state.directory, "secrets", "control-token"), "utf8");
    const oldSocket = await lstat(state.socket).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (oldSocket && !oldSocket.isSocket()) throw new Error("Refusing to replace a non-socket control path.");
    if (oldSocket) await rm(state.socket);
    server = createServer(socket => {
      socket.setTimeout(2000, () => socket.destroy());
      let input = "";
      socket.on("data", data => {
        input += data;
        if (input.length > 1024) { socket.destroy(); return; }
        if (!input.endsWith("\n")) return;
        try {
          const request = JSON.parse(input);
          if (request.token !== token || request.action !== "down") { socket.end("denied\n"); return; }
          socket.end("stopping\n");
          requestStop();
        } catch { socket.end("denied\n"); }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(state.socket, resolve);
    });
    ownsSocket = true;
    await chmod(state.socket, 0o600);
    let closePromise;
    return () => closePromise ??= (async () => {
      await new Promise(resolve => server.close(resolve));
      await rm(state.socket, { force: true });
      await rm(lock, { force: true });
    })();
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (ownsSocket) await rm(state.socket, { force: true });
    await rm(lock, { force: true });
    throw error;
  }
}

export async function requestShutdown(state) {
  const token = await readFile(join(state.directory, "secrets", "control-token"), "utf8");
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection(state.socket);
      socket.setTimeout(5000, () => socket.destroy(new Error("Development stack control timed out.")));
      socket.once("error", reject);
      socket.once("connect", () => socket.write(JSON.stringify({ action: "down", token }) + "\n"));
      socket.once("data", data => {
        socket.end();
        if (data.toString().trim() === "stopping") resolve();
        else reject(new Error("Development stack refused the stop request."));
      });
    });
  } catch (error) {
    if (!["ENOENT", "ECONNREFUSED"].includes(error.code)) throw error;
    const pid = await readFile(join(state.directory, "runtime.lock"), "utf8").then(Number, () => null);
    if (running(pid)) throw new Error("The development supervisor is alive but its control socket is unavailable. Stop it in its terminal first.", { cause: error });
    return;
  }
  const deadline = Date.now() + 30_000;
  while (await lstat(join(state.directory, "runtime.lock")).then(() => true, () => false)) {
    if (Date.now() > deadline) throw new Error("The development stack has not finished stopping. Check its terminal before resetting state.");
    await delay(100);
  }
}
