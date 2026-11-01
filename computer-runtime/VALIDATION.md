# Computer development validation — 2026-10-31

Tested from the `cua/2026-10-31` working tree, based on
`f823773b07ec6ca29d60b31c31af30218a68000d`, with pre-existing working-tree
changes preserved. No commit or release was created. This records successive development checkpoints, including explicit image migration.
It does not claim full P0–P5 acceptance or completion of P6/P7. The latest checkpoint results are appended below;
the earlier tables retain their original run scope.

## Environment

- Linux x64 runtime in WSL; Node.js `22.23.2`.
- Native Windows Node.js `24.22.1`; WSL distribution `Ubuntu-24.04`.
- DSH harness `0.2.1-rc.4`, using exported tool, scope and attachment APIs.
- Local Docker; Cua Driver `0.37.0`.
- Tested local image ID:
  `sha256:05c781b5fe711e1b3c62247ca5074ef33851306c2de5ed4e4683f9478dfd5c7a`.
- Base image/wheel pins: `runtime.lock.json`.
- Dedicated temporary test homes, synthetic configuration and offline desktop
  fixtures. No user DSH profile or real model credentials were used.

## Original 50% checkpoint results

| Check | Result | Scope |
|---|---|---|
| `npm test` in `ds-bot/` | **1332 passed, 2 skipped, 0 failed** | Ownership, leases, approval/image bridge, cancellation, IPC, human tickets, file permissions and client behavior |
| Client build and `--check` | Passed | Generated `client.js` includes the Computer panel |
| `npm run lint` | Passed with warnings | No lint errors; existing warnings and deliberate control-character regex checks remain |
| Broker oxlint | Passed | `computer-runtime/broker/` checked separately |
| App suite under native Windows Node | **211 passed, 0 failed** | Includes the explicit Computer config patch and existing desktop lifecycle tests |
| Python file transfer boundary tests | **3 passed** | Real dirfd operations, paths/links, regular files and bounded import/export |
| Python syntax | Passed | Broker helper and test fixtures parse |
| Standalone real guest smoke | Passed in the initial prototype run | Non-root, 1280×800 PNG, real click, independent HTTP marker |
| Final composed Linux Computer smoke | **Passed** | Public DSH tool runtime → Broker → CUA MCP → offline browser fixture |
| Native Windows bridge smoke | **Passed** | Windows Node → WSL Broker → real Docker guest; no GUI claim |
| Windows desktop GUI | **Not accepted; user will test** | App starts and exposes `computer: true`; baseline first-run modal blocks further UI flow |
| Whole-team Web smoke | **Not fully passed** | Earlier baseline connection reset; latest attempt timed out during host startup |

The final composed Linux smoke verified:

1. Startup of the labelled, non-root, offline desktop.
2. A real PNG saved as a DSH attachment with matching model coordinate space.
3. Exactly one browser marker for a real click. The driver's unverifiable
   receipt remained `unknown`; input was not replayed.
4. Text input, Enter and scrolling producing independent browser markers.
5. Read-only preview between model capture and input without replacing its capture.
6. Human takeover, input, exact file-byte roundtrip, and immediate model
   observation after giving control back.
7. Takeover denying model observation, and stop/start retaining a file in home.
8. Cleanup of the test container, named volume and temporary plugin home.

The native Windows bridge smoke independently verified startup/preview, human
input, exact import/list/export bytes, stale-window release rejection and file
persistence after restart. It exercises the transport used by the desktop app,
but does not validate Electron rendering, file dialogs or user interaction.

During these runs, global `cua-driver revoke --all` was found to suspend all
future authorization. The Broker now enumerates and revokes active sessions,
checks that none remain, closes transports and rotates session names. The final
Linux and Windows bridge passes include this corrected implementation.

Native screen transitions can trigger `desktop changed during approval`.
Fixtures retry only this explicit **pre-dispatch** refusal after observing again;
unknown input is never retried. This verifies the conservative guard, not that
dynamic desktop approval is already convenient.

## Client regression checks

The final component tests exercise actual bundled ComputerView behavior with
controlled hooks, timers and channel responses. They cover unchanged PNGs with
new frame IDs (the browser does not fire a second image load), changed/expired/
failed images, one input for repeated clicks, hidden-panel in-flight responses,
stopped polling and unmount without automatic human-control release. These are
component tests, not Windows GUI evidence.

## Whole-team Web smoke findings

- The first-stage run passed 49 steps and failed 3. The initial model-selection
  `fetch failed` was reproduced with unchanged HEAD versions of `index.js`,
  `channel.js` and `roster.js`, with transport code `ECONNRESET`. Computer was
  disabled. This does not identify the underlying cause or waive the gate.
- Two MCP checks used a snapshot missing the existing `dev/mcp-echo-server.mjs`
  fixture. After correcting that temporary setup, all four focused capability
  checks passed (own chat, group, non-inheritance and detachment).
- The second-stage complete-run attempt timed out after 180 seconds waiting
  for host startup, before smoke steps ran. Its runner cleaned up processes
  and temporary data. The whole-team release gate remains open.

## Windows GUI handoff

An isolated native Electron source build launched the app and loaded the new
plugin. The authenticated roster reported `computer: true`. The first-run DSH
“预览版说明” / Continue acknowledgment could not save, so the Computer panel
could not be manually accepted. Repeating with `DS_BOT_COMPUTER_CONFIG` unset
reproduced the same failure. Its cause is unresolved; DSH was not patched and
the modal was not bypassed. The saved window screenshot shows this baseline
modal only and is not Computer UI evidence.

The user explicitly owns further Windows GUI testing. Use `start-cua.ps1` and
the [manual checklist](README.md#manual-acceptance-checklist). Application
startup, backend bridge validation and full GUI acceptance are separate results.

## Cleanup and limits

Test runners close their own app/processes and remove their containers/volumes.
The original 50% run’s final Docker check found no Computer containers or volumes. The built image,
installed source dependencies and isolated Windows test artifacts are retained
for development; no global Docker prune was used.

At the 50% checkpoint there was no real visual-model reasoning evaluation, complete screenshot-through-
model-request test, group handoff recovery, model file delivery into chat,
network policy/login flow, checkpoint/rebuild/upgrade test, packaged Windows
certification or complete image SBOM. `assisted` retains existing host tool
permissions. Files are manual flat transfers up to 256 KiB. Read-only preview
remains available while a model action waits for approval through a separate
CUA session.

The development setup is in [README.md](README.md); remaining milestones are in
[the plan, section 24](../docs/plans/2026-10-31-cua-computers.md#24-实现进度记录2026-10-31).

## Preview disappearance fix — 2026-10-31

A user screenshot showed `A desktop operation is still settling.` while a model
action waited for approval. The service held its exclusive lane throughout the
wait; the client cleared the image on each busy refusal. This was not a health
check interval or container shutdown.

Read-only preview now uses the existing separate driver session during the
approval wait. Only one capture may run at a time. Approval completion drains
that capture before model re-observation/input; takeover and stop cancel it
through the operation signal. Actual input remains serialized. The client keeps
the previous image on a busy refusal, labels it as waiting and disables input
until a successful refresh; lost authority still clears the frame. The polling
interval remains 1.5 seconds.

Regression tests cover preview during approval, overlapping captures, approval
while a capture is pending, cancellation on takeover, and busy-to-fresh client
recovery. The real Linux composed smoke passes with a preview inside every
approval callback, followed by verified browser input markers. Windows GUI
retesting remains with the user.

Final fix verification: plugin suite **1336 passed, 2 skipped, 0 failed**;
client build/bundle check and plugin/Broker lint passed (plugin warnings remain).

## Per-desktop YOLO mode — 2026-10-31

The user requested an approval-free CUA mode. The desktop panel now offers
`required` (default) and `yolo`, saved per Computer independently of the assisted
execution policy. Tests cover persistence, legacy records, restoring approval,
model arguments failing to override the mode, fresh frames, owner/grant checks,
human takeover, and unknown-result replay prevention. The component test selects
both modes through the panel and checks the management payload.

All 63 focused Computer tests passed. The real Linux composed smoke switches
to YOLO and verifies text, key and scroll markers without any new approval
requests; human takeover and persistence checks also pass. The final plugin suite
reports **1341 passed, 2 skipped, 0 failed**. Client build/bundle check and lint
passed (existing lint warnings remain). Windows GUI validation remains with the
user. The running user desktop and its saved settings were not changed by tests.

## 75% development checkpoint — 2026-10-31

Latest verification for the file/handoff/recovery batch:

| Check | Result | Evidence and limits |
|---|---|---|
| Plugin suite | **1358 passed, 2 skipped, 0 failed** | `/tmp/cua75-complete-tests.log`; latest full run on the working tree |
| Client build and generated-bundle check | **Passed** | Includes Computer help dock and recovery controls; `/tmp/cua75-complete-bundle.log` |
| Plugin / Broker lint | **Passed** | Plugin warnings remain; `/tmp/cua75-complete-lint.log`, `/tmp/cua75-broker-lint.log` |
| Real DSH AgentLoop test | **Passed** | `test/computer-loop.test.js`: actual loop/model request/tool pipeline with no-key mock adapter, normalized image, file import/export and a new turn after takeover answer |
| Python transfer/checkpoint tests | **5 passed** | No-follow transfer boundaries; checkpoint roundtrip, symlinks, corruption, identity and size refusals; `/tmp/cua75-python.log` |
| Real composed Linux guest smoke | **Passed** | `/tmp/cua-next-real.log`: screenshot, approval, YOLO input markers, human controls, real DSH file attachments, stop/start, checkpoint restore and recreate |
| Whole-team Web smoke | **Blocked before startup** | `/tmp/cua75-bench.log`: required local `deepseek-harness` checkout is absent. The bench was stopped; this gate remains open |
| Windows GUI / native Windows suite | **Not run in this batch** | User will test the Windows app; earlier native bridge/app results above are not new GUI evidence |

The intermediate full run encountered one timing assertion in the existing
`mock-llm.test.js` slow-response test. The next two full runs passed, including
the final run above; that unrelated test was not changed.

The real guest smoke creates one random Computer and deletes only its own
container and labelled volumes, including backup and restored-home volumes.
The user's existing Computer container was left running. No user DSH data,
real API credentials, global Docker prune, commit or push was used.

The new recovery format is a stopped-home staged file tree plus SHA-256 manifest,
not a tar archive. It restores into a fresh volume, verifies before publication,
and retains the previous home. Tests cover corruption refusal and failed restore
not publishing a new home; exhaustive power-loss/crash injection and automatic
orphan cleanup are still missing. Limits: 128 MiB / 10000 entries per checkpoint,
two retained checkpoints and two prior restored homes. The format preserves
regular file bytes/modes and symlinks, not ownership/ACL/xattr/hard-link identity.

Handoff tests cover own/group destinations, current group parts, restart,
control-token requirements, duplicate answers, cancellation while resolving,
final inbox validation, explicit stop, departed groups, preflight retries and
ambiguous delivery. The mock loop does not establish real visual reasoning or
an end-to-end Windows group UI flow. `computer-only`, network policy, image
upgrades, packaging/SBOM and the full release matrix remain unfinished.

## 85% checkpoint — storage recovery and runtime delivery

This is an implementation-effort estimate, not a release acceptance percentage.
No Windows GUI acceptance is claimed; that remains with the user.

| Check | Result | Evidence scope |
|---|---|---|
| Plugin `npm test` | **1367 passed, 2 skipped, 0 failed** | Full final suite, including restart recovery, blocked access after failure, explicit cleanup, rollback metadata, generation invalidation and stale UI confirmation |
| Client build and `--check` | Passed | Regenerated `client.js` from source |
| Plugin lint | Passed with warnings | No lint errors |
| Broker and runtime CLI lint | Passed | Separate oxlint invocation |
| Python file/checkpoint suites | **5 passed** | Includes the checkpoint manifest and parent-directory fsync path |
| Real composed Linux Computer smoke | **Passed** | Existing input/attachment flows plus old-home rollback, backup capacity reuse, current-byte retention and interrupted-restore cleanup |
| Runtime preflight | Passed | Existing immutable local image, local Docker, Linux x64, non-root image and pinned protocol/driver labels |
| Standalone bundle | Passed | 16 payload files; SHA-256 inventory verified; copied CLI can inspect the real runtime without source-checkout imports |
| Runtime bundle negative tests | Passed | Existing output directory refused; changed bytes and unexpected manifest paths refused |
| Generic Web bench | See final result below | Public CLI mode, isolated mock data; no DSH patch |
| Windows GUI / packaged installer | Not tested in this checkpoint | User owns GUI testing; standalone Broker payload is not installer integration |

The real storage fault test throws after the Broker has successfully staged a
restored home but before the host publishes it. It verifies the staging volume
exists, runs recovery, verifies only that staging volume disappears, then starts
the authoritative old home and checks its exact file bytes. Separate fake tests
restart the service with a persisted intent, fail cleanup, verify start/rebinding/
observation/takeover stay blocked, then retry successfully. These are controlled
fault injections, not a physical power-loss test.

Only the smoke's own randomly named, labelled resources were removed. The
user's existing Computer container was not stopped or changed. Tests used mock
models and synthetic data; no actual visual-model quality claim is made.

The runtime `build` command's lock/argument composition is implemented; this
checkpoint reused the already built immutable image rather than downloading and
rebuilding it. The bundle inventory is not a full guest OS/dependency SBOM or
signature. `TOOL_POLICY.md` records the remaining `computer-only` isolation work;
that mode remains unavailable.

### Generic Web smoke final result

The public CLI bench completed with **51 steps passed, 1 failed**. The
failure is `user picks a model; Chief greets and asks in its reply: fetch failed`.
Subsequent Bot creation, views, group collaboration/memory, context rollover,
work folders, handoffs and capability isolation steps passed. This is **not a
green release gate**. A similar model-selection failure was recorded in the
earlier baseline investigation; this checkpoint did not rerun an unchanged
baseline and makes no new root-cause claim for that request failure.

The first mounted-drive attempt exceeded the startup window. A restart then
reported credentials mode 777 on the WSL-mounted test directory, which the public
DSH credentials service correctly refused. The completed run used a new isolated
`.dsh-test-cua-native` directory backed by Linux `/tmp`, public `DSH_CLI` and a
300-second startup allowance; no credentials checks or DSH code were patched.
Both benches and the composed guest's own resources were stopped/cleaned after
the run. The user's existing Computer was left untouched.

## 90% checkpoint — application payload and image ownership

This checkpoint implements app packaging integration; it does **not** claim a
signed installer or Windows GUI acceptance.

| Check | Result | Scope |
|---|---|---|
| Plugin final `npm test` | **1371 passed, 2 skipped, 0 failed** | Includes image pin persistence, legacy provenance, blocked image changes and corrected empty assignments |
| Client build and `--check` | Passed | No manual bundle edits |
| Plugin lint | Passed with existing warnings | No errors |
| App packaging/configuration tests | **15 passed** | Pack hook, resource mapping, outside-checkout resolution, WSL argument mapping, opt-in, corrupt/absent payloads, lock exclusion and failed preparation retention |
| App full suite attempt | **Blocked** | 213 passed, 1 skipped and 1 cancelled; first-run Session check's setup failed because this installed dependency tree lacks `node-addon-require-builtin-linux-x64-gnu` |
| Broker/app runtime lint | Passed | Separate targeted lint; no errors |
| `prepare-computer-runtime.mjs` | Passed | Generated actual `app/build/runtime/computer-runtime`; 16-file manifest verified |
| Real payload smoke outside checkout | **Passed** | Copied generated payload to a Linux temporary directory; real Broker/guest screenshot, file bytes across stop/start, image identity and cleanup |
| Real composed Computer smoke | **Passed** | All prior input/file/recovery flows plus a different configured image rejected while current bytes remain unchanged |
| Generic Web smoke | **51 passed, 1 failed** | Model-selection request still reports `fetch failed`; subsequent team/room/memory/capability flows passed |
| Native Windows / GUI / signed installer | **Not run in this checkpoint** | GUI remains user-owned; WSL path conversion is covered with an injected converter, not claimed as native acceptance |

The full app attempt preceded the last two packaging probes; final focused app
tests cover those additions. The missing native binding is an environment gate,
not a passing suite. No DSH implementation, credentials check or user dependency
installation was patched to bypass it. No complete NSIS/AppImage build was run;
`beforePack`, `extraResources`, the generated payload and copied-payload runtime
were exercised independently. The desktop image was reused by immutable ID,
without downloading or changing the user's container.

The image guard records an immutable ID in each assignment and labels new
volumes. It does not migrate browser profiles. A legacy home with no verifiable
image stays blocked; an absent current home is not considered empty when old
homes, checkpoints or unfinished storage operations remain. Only a verified
empty assignment can adopt a corrected image configuration, with a new generation.

Both mock bench processes and the disposable Computer containers/volumes were
cleaned up. The user's existing Computer was left running. Remaining release
gates include the Web model-selection failure, native app/Windows installer
acceptance, cross-image migration, disk quotas, network policy, guest SBOM and
actual vision-model/performance evaluation.

## Image migration and delivery checkpoint

The plan's completion checklist is now marked by evidence, with outstanding
items left open. This checkpoint is **not 100% completion** of the original plan.

| Check | Result | Scope |
|---|---|---|
| Plugin final unit suite | **1379 passed, 2 skipped, 0 failed** | Includes ordered image admission, image/home pairing, interrupted-upgrade recovery, image metadata persistence, stale diagnostics, shared startup/upgrade quota, UI image choice and fixed WSL argv |
| Client build and generated bundle check | **Passed** | Generated from sources; no manual bundle editing |
| Plugin lint | **Passed with warnings** | Existing warnings remain; no errors |
| Targeted Broker/runtime lint | **Passed** | No warnings/errors in the checked runtime files |
| Focused app packaging/config tests | **15 passed** | Includes the expanded 18-file verified inventory |
| Python checkpoint tests | **4 passed** | Copy integrity, corruption, limits, low-space admission and symlink-safe usage scan |
| Real composed Computer smoke | **Passed** | Public DSH tools and attachments, actual CUA input markers, approval/YOLO, human control, file transfer, stop/start, checkpoint/restore/recreate/rollback, lost-response recovery; storage diagnostics and loopback-only guest networking |
| Real image-upgrade smoke | **Passed** | Rejects a root-user candidate, verifies both candidate stages, switches image/home together, preserves original profile on paired rollback, recovers a successful but unpublished candidate |
| Generated app runtime smoke | **Passed** | Actual generated Broker payload; real screenshot and file bytes across stop/start; temporary resources cleaned |
| Generic Web smoke | **All 52 steps passed** | Fresh isolated `/tmp`-backed bench, public CLI, mock models; no retry added to mutating requests |
| Actual guest inventory | **501 components** | Installed dpkg/Python package names/versions, available notices and hashes; stored in `evidence/guest-sbom.cdx.json` |
| Windows GUI / signed installer | **Not run** | User-owned GUI acceptance; no claim of full platform release readiness |
| Full app suite | **Still not accepted** | Earlier full run's missing Linux native binding remains unresolved; focused tests do not replace it |

Measured on this WSL/Linux x64 client with its local Docker Desktop Linux Engine:
cache-warm startup **1838 ms**, screenshot p95 **648 ms** over **10** sequential
samples, migration **7708 ms**. The raw timings and scope are in
`evidence/local-performance.json`. Two temporary images derived from the same
pinned image prove transactional behavior, not cross-browser-version migration
compatibility. These are not Windows GUI or model latency measurements.

The earlier Web `fetch failed` was captured as `ECONNRESET`. A separate clean
first-model reproduction and the final full run both passed unchanged. There is
no evidence of a deterministic application fix, and no claim that the intermittent
transport issue is permanently resolved. DSH, credentials handling and mutation
retry policy were not changed to turn the run green.

Reproduce from the repository root (use the prepared immutable image ID):

```sh
node --import ./ds-bot/test/harness-resolve.mjs ds-bot/dev/computer-smoke.mjs IMAGE_ID
node ds-bot/dev/computer-upgrade-smoke.mjs IMAGE_ID
node computer-runtime/runtime.mjs inventory IMAGE_ID
python3 computer-runtime/test/checkpoint_test.py
node app/scripts/prepare-computer-runtime.mjs
node app/scripts/check-computer-runtime.mjs app/build/runtime/computer-runtime IMAGE_ID
```

The generated payload includes 18 files plus `manifest.json`; the newly included
files are the guest inventory helper and CUA MIT notice. The app and standalone
verifiers use the same closed inventory. The standalone verifier also rejects
substituted symlinks, even if their target bytes have a matching digest.

Unfinished development/release work remains: graphical image preparation and
background progress, enforceable disk quotas, restricted online egress,
computer-only's audited DSH effect boundary, additional platforms/browser versions,
full signed installer acceptance, actual visual-model quality/performance, and
P6/P7 long jobs/shared/remote/mobile/host providers. See plan §24.9. No percentage
estimate is used to hide these gaps.

All processes, containers, volumes and temporary image variants created by this
checkpoint were cleaned. The Web bench symlink and its isolated temporary home
were removed. A final Docker listing contained only the pre-existing user
Computer; it was neither stopped nor altered. No commit, push, installer release
or user DSH data migration was performed.


## Installed-plugin entry fix

The plugin enable switch was being mistaken for Computer runtime readiness.
Bot settings, the details menu and the right panel now keep the Private desktop
entry when the Host advertises `computer: false`, and render a setup page without
mounting the live viewer. Older Hosts without the capability field remain hidden.
No host configuration, runtime launch, polling or download occurs on that page.

Validation: **1381 passed, 2 skipped, 0 failed**; client build, bundle check and
lint passed (existing lint warnings remain). Regression coverage checks disabled
runtime discovery, absent Host capability, group exclusion and zero provider calls
from the setup page. No host code changed, so no new host smoke was needed.

A local preview artifact was built as `artifacts/ds-bot-0.2.5-cua.1.tgz` to follow
the user's installed `0.2.5-cua.0`. Only the staging package version was changed;
the repository release version remains unchanged. The archive was checked for
the updated generated client, README, plugin entrypoint and Computer host files.
It was not published or installed into the user's DSH. Installing it fixes entry
discovery; it still requires the separately configured Broker and guest image.
The shared checkout's Windows esbuild installation was preserved; Linux build
checks used the same esbuild version from an isolated temporary tool directory.


## Installed-plugin preparation and native Windows Docker

The approved first-use plan now has an implementation of batches A–C: the npm
plugin ships its verified Broker payload, discovers a local Docker engine, saves
its identity, builds the pinned desktop recipe and waits for an actual screenshot.
The setup UI exposes persistent progress, cancel and retry. It starts with
observe-only access; the existing operate and YOLO controls remain explicit.
This checkpoint does not mark A–C acceptance or the entire CUA plan complete.

| Check | Result | Scope |
|---|---|---|
| Final plugin unit suite | **1394 passed, 2 skipped, 0 failed** | Persistent setup, engine selection, cancellation, UI lifecycle, scoped tools, payload tampering and existing Bot behavior |
| Build and generated checks | **Passed** | Client and 19-file runtime payload match their sources |
| Plugin and runtime lint | **Passed with warnings** | No errors; includes intentional control-character validation regex warnings |
| Focused app runtime tests | **7 passed** | Payload inventory, native transport and packaging configuration |
| Real composed Computer smoke | **Passed** | Public DSH tools, guest input, approval/YOLO, attachments, control, files, checkpoint/restore/recreate/rollback and recovery |
| Native Windows cached-image setup | **Passed, repeated after final build** | Windows Node → plugin payload → native Docker named pipe → Broker; screenshot, file roundtrip, checkpoint, stop/start, engine persistence |
| Native Windows actual build cancellation | **Passed** | Cancels a real preparation; taskkill terminates the owned Docker/buildx process tree and releases inherited pipes |
| Native Windows child-process fixture | **1 passed** | Independently checks that the descendant process is gone after cancellation |
| First preparation without an image cache | **Not accepted** | Fixed base resolution and pinned wheel download began, but the download stalled and the 20-minute smoke budget expired |
| Generic Web smoke | **51 passed, 1 failed** | Fresh temporary home and public DSH CLI; first model selection returned `fetch failed` |
| Windows GUI / signed installer | **Not run** | User will perform native app GUI testing; no installer release claim |

The first uncached Windows run exposed a real cancellation defect: terminating
only docker.exe left docker-buildx.exe alive with inherited stdout/stderr pipes.
The fix kills the owned process tree on Windows, and the owned process group on
Linux, with bounded termination handling. Both the Windows process fixture and
actual Docker cancellation passed afterward. No global process or Docker cleanup
was used. Build cancellation retains reusable layers and does not promise to
remove Docker's shared build cache.

A cached-image run is not first-download evidence. It seeds only the isolated
fixture's setup config with an explicitly supplied immutable image ID. Normal
users still click Prepare and start; the implementation selects and verifies the
image without asking them to enter that ID. The guest remains offline even though
host-side image preparation needs registry/package-index access.

A local test artifact, `artifacts/ds-bot-0.2.5-cua.2.tgz`, includes the generated
client, setup service, trusted verifier and all 19 runtime files plus manifest.
The extracted archive successfully loaded its own verified runtime from a
standalone temporary directory, without the source checkout or app directory.
The extracted package also passed the cached-image native Windows setup smoke,
including screenshot, file transfer, checkpoint and stop/start, with no dependency
on the source runtime. Only the staging package version changed; the source
release version remains 0.2.4. The SHA-256 is recorded beside the artifact. This package was not published
or installed into the user's DSH.

Reproduce the targeted native tests with Windows Node (or Linux Node for the
corresponding platform); use only an immutable, previously verified image ID:

```sh
node ds-bot/dev/computer-setup-smoke.mjs IMAGE_ID
node ds-bot/dev/computer-setup-smoke.mjs --cancel
node --test ds-bot/test/computer-engine.test.js
node ds-bot/scripts/build-computer-runtime.mjs --check
```

Running `computer-setup-smoke.mjs` without an image argument exercises actual
image preparation. All fixture metadata lives under a newly created
`.dsh-test-setup-*`; cleanup uses only that fixture's registry identities and
labelled volumes. It never adopts the user's existing Computer.

Remaining gates: uncached first preparation through the Windows GUI, Podman
adapter/machine management, runtime installation and system-restart recovery,
published digest-pinned OCI images, signed installer/platform acceptance, and the
other unfinished items in the main CUA plan. The implementation provides Docker
installation guidance; it does not install system components automatically.

The final generic Web run passed the view-card and handoff checks that had failed
in an earlier run, but its first model-selection request returned `fetch failed`.
This remains an unresolved validation exception, not a claimed fix or a proven
pre-existing defect. No automatic retry was added to mutating API requests and
DSH was not patched. A separate restart attempt on the mounted Windows filesystem
was refused by DSH because its fixture credentials file reported mode 777; the
final bench used a fresh Linux temporary directory instead. No user credentials
or DSH data were read or modified.

The test benches were stopped and their temporary homes removed. The standalone
native setup smokes cleaned their owned containers and volumes. The existing
user Computer was left running and unchanged.


## 2026-11-01: Experimental Podman and image-candidate delivery

The setup flow now offers an explicit experimental Podman selection, including
Windows preparation of the dedicated rootful `ds-bot` machine. The selected
machine/connection/store stays pinned, and every Broker subprocess uses the same
connection arguments. Saved machine preparation can be retried after a Host
restart without replaying system changes merely by opening the application.
Rootless and remote engines are rejected by this adapter. Actual Podman lifecycle
acceptance has not been performed: no Podman runtime is installed on this host.

The optional `publishedImage` lock field accepts only an immutable GHCR digest.
A manual candidate workflow builds, verifies, exercises and inventories the image
before an explicitly selected publication step. The workflow has not been run,
no image has been published, and the current lock has no published reference.
The shipped setup therefore continues to build locally.

| Check | Result | Scope |
|---|---|---|
| Final plugin unit suite | **1407 passed, 2 skipped, 0 failed** | Includes Podman endpoint/store isolation, machine preparation, persistent choice, restart retry and preserved image recipe provenance |
| Build, client and runtime checks | **Passed** | Generated runtime now contains 20 files plus manifest |
| Plugin and runtime lint | **Passed with warnings** | No lint errors; control-character validators intentionally use bounded regexes |
| Focused app runtime tests | **7 passed** | Native transport and complete payload inventory |
| Native Windows adapter/cancellation fixtures | **7 passed** | Path handling, fixed argv, simulated Podman metadata and real child-process cancellation; not a real Podman engine |
| DSH → Broker → real Docker guest | **Passed** | Input, approvals/YOLO, screenshots, files, human control, checkpoint/restore/recreate/rollback and recovery |
| Final extracted npm package on Windows | **Passed** | Native Windows Node/Docker, cached image, actual screenshot, file transfer, checkpoint and stop/start |
| Generic Web smoke | **51 passed, 1 failed** | First model-selection request failed with `ECONNRESET` |
| Isolated first-model HTTP diagnostic | **2 steps passed** | Fresh bench, Connection: close, no mutation retries; suggests a connection-reuse issue but does not prove the root cause or fix DSH |
| Image candidate workflow | **YAML and shell syntax passed** | Not remotely executed or published |
| Real Podman / clean Windows first use | **Not run** | Still an acceptance gate |

During package review, cross-platform Git newline conversion was found to make
raw source hashes non-reproducible. The builder now canonicalizes its closed
UTF-8 text inventory to LF, and generated runtime files disable Git's automatic
text conversion. Runtime verifiers still hash exact installed bytes; no runtime
normalization bypasses tamper detection. Build/check uses the same canonical
source representation. Existing pinned images retain their original recipe
metadata when a newer plugin is installed.

The local preview artifact is `artifacts/ds-bot-0.2.5-cua.3.tgz`; its SHA-256 is
recorded alongside it. Only the staging package version changes. The final
archive was extracted into an independent temporary directory and exercised
through Windows Node with the existing verified immutable Docker image. No
checkout runtime path or app path was needed. It was not installed into user DSH,
published to npm, or signed as a desktop installer.

For real Podman acceptance, run the standalone setup smoke with
`--engine=podman`, optionally supplying an immutable image already in that engine's
store. On Windows, `--prepare-runtime` explicitly permits creating/starting the
fixed dedicated machine; the script retains the machine and only cleans its
owned Computer containers/volumes. Do not treat a Docker cached image as present
in Podman's separate store.

Remaining work includes real Podman lifecycle/storage acceptance, automatic
system-component installation, clean Windows first preparation and GUI checks,
actual approved OCI publication/lock update, signed installer acceptance and the
other deferred main-plan items. The pooled Web transport exception remains open;
no production API retries or DSH patches were introduced. All test benches and
temporary test homes from this checkpoint were removed; the existing user
Computer was not stopped or modified.

## 2026-11-01: noVNC observation and retained display

Implemented a read-only RFB bridge in the canonical Broker and the generated
plugin runtime. The Computer panel uses noVNC via DSH's authenticated exact
Fetch route on both carrier types. Human control still displays the verified
PNG used for input authorization. Both paths retain the previous canvas pixels
while a new frame loads or the stream reconnects.

Verification for this change:

- Full unit suite: 1,419 passed, 2 skipped, 0 failed (1,421 total).
- After the final poster/visibility changes: 151 focused Computer, installation,
  generated-client and translation checks passed.
- Client and runtime generated-output checks passed. Lint exited successfully
  with existing warnings outside the new streaming implementation.
- `dev/computer-stream-smoke.mjs` passed against a newly created isolated
  TigerVNC desktop with a real Chromium/noVNC client. It verified incremental
  updates, stable presentation-canvas identity, retained pixels during an
  injected outage, successful reconnect and retention after invalid PNG decode.
  The test removed its own container, volume, browser and temporary home.
- The actual pinned DSH 0.2.1-rc.4 Web route rejected an unauthenticated viewer
  request (401) and admitted the authenticated owner to the route (503 for the
  deliberately unconfigured test runtime).
- The generic mock-model smoke test did **not** pass: `show_view` option/large
  view assertions failed. Bootstrap, model selection, Bot creation, group
  messaging and memory flows ran successfully. The broad run was stopped after
  these failures; it must not be reported as a passing full DSH regression.
  All processes started by this run were stopped. DSH itself was not modified.
- Windows GUI validation remains user-run; it was not performed in this WSL
  session. The transport uses the public Desktop-capable Fetch contract.

Local test artifact: `artifacts/ds-bot-0.2.5-cua.4.tgz`.
Only the staging package version was changed; the repository version remains
0.2.4. Packaged host files and client match the tested workspace, all runtime
manifest hashes were checked, and noVNC source/license notices are included.
SHA-256: `f9f6038d1099a8aae81a05b3e6de02c1927479d7cfd348960cd49498b988b594`.
