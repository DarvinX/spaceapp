import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function withLifecycleLock(root, operation) {
  const directory = join(root, ".dev-stack-operation.lock");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error("Another dev:stack operation owns .dev-stack-operation.lock. Wait for it to finish. If it was killed, verify no dev:stack operation is running before removing that directory.", { cause: error });
  }
  const ownerFile = join(directory, "owner.json");
  const token = randomBytes(16).toString("hex");
  try {
    await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
    return await operation();
  } finally {
    // Never delete a replacement guard if someone manually recovered this one during the operation.
    const owner = await readFile(ownerFile, "utf8").then(JSON.parse, () => null);
    if (owner?.token === token) await rm(directory, { recursive: true });
  }
}
