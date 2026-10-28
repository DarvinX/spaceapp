# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.

The `run-spaceapp` installer is a separate package with its own host Node
requirement. Installing the application and developing this monorepo have
different prerequisites; consult the selected installer's `engines` field.

From the repository root, install the locked dependencies:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

Skipping the Electron download is suitable for core development. Desktop
packaging requires its normal toolchain and separate platform acceptance.
Dependency installation may use the network; the smoke command below does not
need a provider account, API key, Docker, PostgreSQL or Temporal.

## Run the full app from source

After the dependency installation above, start the complete development stack:

```sh
npm run dev:stack
```

Docker Engine with Compose v2 must be running, and `sqlite3` must be on `PATH`
for the application's SQLite-backed features. The command starts PostgreSQL
with pgvector and Temporal in Docker, builds this checkout, applies migrations,
then starts the API, Vite, Temporal worker and CLI host from this checkout.
OpenCode is installed at the version pinned in `Dockerfile`, inside the
checkout's state directory. No global provider installation or AI account is
needed to open its terminal UI. Dependency images are read from the launcher's
digest-pinned Compose template.

Wait for the printed URL and one-time setup token. Open that URL, create the
owner with the token, and sign in normally. The Getting Started room includes
an OpenCode pane. This stack uses the normal owner setup and authentication;
the development login shortcut is disabled. The browser service, companion
services and root access are unavailable here. Provider calls still require
an available model and, where applicable, provider credentials.

The command stays in the foreground with service-labelled output. A service
exit stops the stack and reports the failure. Stop it with Ctrl+C, or use
another terminal in the same checkout:

```sh
npm run dev:stack -- down     # stop processes and containers, retain data
npm run dev:stack -- reset    # also remove this checkout's volumes and state
```

Each checkout has its own Compose project and git-ignored `.dev-stack/`
directory. Secrets are generated once per state directory with mode 0600;
only the setup token is printed. The stack does not inherit operator API keys,
SpaceApp settings, provider homes or Node preload hooks. The installed
application's containers and volumes are outside its cleanup scope.

Every exposed port binds to `127.0.0.1`:

| Service | Default port | Override before first start |
| --- | --- | --- |
| Web | 5911 | `SPACE_DEV_WEB_PORT` |
| API | 5910 | `SPACE_DEV_API_PORT` |
| PostgreSQL | 55432 | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | 57233 | `SPACE_DEV_TEMPORAL_PORT` |
| OpenCode server | 5799 | `SPACE_DEV_OPENCODE_PORT` |

Ports are saved with the state. Run `reset` before changing them. Ports 4910
and 4911 are reserved for installed SpaceApp and are refused by this command.
API source edits restart the API; web source edits use Vite hot reload. After
editing an internal package or worker source, run the following in a second
terminal; the service watchers pick up the rebuilt package and worker files:

```sh
npm run dev:stack -- rebuild
```

On macOS, use Docker Desktop or start Colima with enough memory for PostgreSQL,
Temporal and the source processes. Select the corresponding Docker context
before starting. On Windows 11, clone and run inside WSL2, enable Docker
Desktop's integration for that distribution, and keep the checkout on the
Linux filesystem. Native Windows execution is refused because the CLI host
uses Unix sockets and PTYs.

If startup fails, inspect the named service output. Ensure Docker is running,
the selected ports are free, and `npm ci` completed with the supported Node
version. A fresh owner token expires after 15 minutes; restart the stack to
renew its bootstrap window. Use a shorter checkout path if Unix socket paths
exceed the platform limit. `down` preserves the database and generated secrets;
use `reset` only when that development data can be discarded.
Lifecycle operations are serialized. If an operation was forcibly killed and
left `.dev-stack-operation.lock/`, first verify that no `dev:stack` operation
is still running, then remove that guard directory and retry.

Run the lifecycle regressions with `npm run test:dev-stack`. On an isolated
Linux checkout, `node scripts/dev-stack/smoke.mjs` starts the real stack, claims
the owner, signs in again, starts an OpenCode pane, and verifies cleanup. The
source-stack CI job runs this smoke without a TTY.

## First executed task, without a provider

```sh
npm run smoke:offline
```

This builds the CLI host and runs an explicitly **simulated runtime** through
the real Unix socket protocol and a real PTY child. It submits two arithmetic
tasks, checks their results, reconnects without replacing the process, and
resubmits an input key to verify duplicate suppression within that host's
retained session. The child receives an allowlisted environment. Its process,
socket and temporary directory are removed before success is reported.

Success is a JSON record with `mode: "SIMULATED_RUNTIME"`, `passed: true` and
`cleaned: true`. A wrong answer or early child exit fails the command. This is
a contributor transport/acceptance check, not evidence of AI quality, provider
authentication, native task resume, browser behavior or crash durability.

Unix socket paths are short. If your inherited `TMPDIR` is deeply nested,
select a short temporary directory you own and set `TMPDIR` for the command.
On Windows run this particular smoke check inside WSL or a Linux development
container. It does not certify the Windows/macOS installer.

## Make and verify a small change

Work on a branch, not on `main`, so the change can become a pull request:

```sh
git switch -c my-change
```

For example, change the synthetic task's result handling in
`scripts/fixtures/offline-cli.mjs`, then run:

```sh
npm run test:contributor
npm run check
```

The contributor regression tests reject incorrect task output and early process
exit, and check cleanup after both. Restore the intended behavior before
submitting a change. Use the tests for the affected workspace as well; the
offline smoke is not a substitute for them.

## Checks before a commit

After `npm ci`, these commands work in this order, also on a fresh clone:

```sh
npm run check
npm test
npm run build
npm run hygiene:preflight
```

`npm run check` runs the dependency boundary check, builds the internal
`@space/*` packages in dependency order and then type-checks the apps, so it
does not need an earlier `npm run build`. `npm test` builds the internal
packages and runs the test suites in this checkout. `npm run build` also builds
the API, worker and web app. Run `npm run hygiene:preflight` before every
commit: it fails on untracked files and on staged runtime, secret, dependency,
generated or report paths. Commit from your branch; older releases of this
check also refuse to run on `main`.

Opt-in database and authenticated provider proofs require separate isolated
fixtures; skipped proofs are not passing evidence.

In the maintainers' source repository, `npm run check:claims` compares the
version, licence, Node requirement, runtime list and key constants stated in
the README and `docs/` with the code, and rejects unqualified latency or
isolation claims; maintainers run it when a change touches any of them. Current
results and known failures are indexed there in `docs/quality/README.md`, and
its `AGENTS.md` describes the guidance to read before changing session
attachment, room retention, control, readiness, polling or deployment.

Keep changes reviewable and include the exact commands and limitations of your
verification. Never include credentials, private transcripts or local runtime
state in a contribution.

## License of contributions

SpaceApp is licensed under the [MIT License](LICENSE). Contributions are
accepted under the same license (inbound = outbound): by submitting a
contribution you license it to everyone under the MIT License. You keep the
copyright of your contribution.

Every commit must carry a `Signed-off-by:` line with your real name and email,
which certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution or have the right to submit it under the MIT
License. `git commit -s` adds the line. There is no separate contributor
license agreement.
