import { join } from "node:path";
import { startCredentialAgent } from "../../deploy/docker/credential-agent.mjs";

const directory = process.argv[2];
if (!directory) throw new Error("The development state directory is required.");
const server = await startCredentialAgent({
  socketPath: join(directory, "credentials.sock"),
  commandPath: join(directory, "wrappers"),
  socketMode: 0o600
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
