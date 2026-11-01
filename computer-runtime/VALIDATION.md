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

## 2026-11-01: streaming transport and rendering optimization

The Web host now offers an optional authenticated WebSocket through DSH's public
upgrade/admission APIs. Desktop carriers without an HTTP(S) document origin use
Fetch directly; blocked upgrades retire the original viewer before opening a
fresh Fetch viewer. noVNC's native canvas renders live updates without periodic
full-frame copies. A separate poster retains pixels through disconnects.
Reconnect attempts remain bounded across briefly successful connections, and
both transports share sanitized, actionable failure codes. Model release, like
normal end-turn revocation, preserves read-only observation.

Final automated checks for the implementation:

| Check | Result |
|---|---|
| Full plugin suite | **1,431 passed, 2 skipped, 0 failed** |
| Generated client and runtime checks | Passed |
| Plugin lint | Passed; existing warnings remain |
| Real TigerVNC + Chromium: WebSocket | Passed; zero Fetch reads |
| Real TigerVNC + Chromium: forced Fetch | Passed |
| Real TigerVNC + Chromium: rejected upgrade | Passed; fresh-session Fetch fallback |
| Actual pinned DSH WebSocket admission | Anonymous 401, owner admitted, cross-origin 403 |
| Whole-team mock smoke | **51 passed, 1 failed**; model-selection request returned `fetch failed` |
| Windows desktop GUI | User-run; not performed in this session |

Each browser fixture verified incremental updates, retention of the same poster
canvas, retained pixels during outage/reconnect and invalid PNG decode, and zero
recurring `getImageData()` calls during steady live viewing. They removed their
own temporary container, volume and browser. Unit coverage also includes the
512 KiB receive window, invalid/out-of-order acknowledgement rejection,
immediate peer revocation, read-only RFB rejection, terminal auth errors, bounded
retries, exclusive transports and non-HTTP Desktop URL fallback.

The generic smoke investigation found two test-fixture defects. The activity
hint intentionally disappears for a `show_view` call, but the test treated that
as completion before the tool finished saving. Recorded events showed the next
large-view message queued before the preceding view's tool result and turn end.
The smoke now also waits for `work.turns` to empty. Separately, the mock swallowed
a fresh user request when it shared a message with the preceding `show_view`
result; the mock now handles that text and has a regression test. No DSH patch
or disabled assertion was introduced.

A restart of the mounted Windows-filesystem bench was rejected because its
generated test credential file appeared with mode 777. The final isolated bench
uses a Linux temporary directory through `.dsh-test-cua-opt-final`; user DSH data
and the running user desktop were not used.

The final full smoke completed every step. Options-view persistence and reply,
large-view history, group memory, compaction, handoff, folder changes and MCP
attachment/detachment all passed. The model-selection transport failure remains
unresolved, so the whole-team release gate is **not** reported as passing.
This is the same symptom recorded at earlier checkpoints, not evidence of its
underlying cause. No production retry or assertion bypass was added.
Run logs: `/tmp/cua-opt-tests-final.log`, `/tmp/cua-opt-lint-final.log`,
`/tmp/cua-opt-bot-smoke-final.log`, `/tmp/cua-opt-ws.log`,
`/tmp/cua-opt-fetch.log`, `/tmp/cua-opt-blocked.log`.
Both benches and all fixture processes were stopped; the two bench homes from
this optimization run were removed after the results were recorded.

Local preview: `artifacts/ds-bot-0.2.5-cua.5.tgz` (1,054,835 bytes).
SHA-256: `dfd75169d1813ded8a9caf7e0af5734e97a0cf5b458dc1d7587006b32192133d`.
Only the staging package version changes. The archive was independently
extracted and checked against the generated client, host/shared modules,
dependency declarations, runtime manifest hashes and noVNC/ws notices.

Direct human VNC input is still a separate design proposal in
`docs/plans/2026-11-01-cua-screen-stream.md`. Human control continues to use the
visibly presented verified PNG and existing frame-bound input API. This batch
does not claim native Windows GUI acceptance or completion of the other deferred
main-plan release gates.

## 2026-11-01: live human control

Explicit takeover now enables standard noVNC keyboard/pointer input after the
first visible frame. The authenticated open body carries the takeover token;
Host validates the current lease/generation on every write and Broker checks
the RFB allowlist independently. Only one interactive viewer is permitted.
Verified snapshot control remains an explicit alternative, and model actions
retain their existing observation-bound contract.

Window blur, hidden pages and disconnects retain the last pixels and suspend
control until manual resume. A two-second client heartbeat has a three-second
request timeout; the route expires after six seconds without client activity,
checked once a second. Automatic WebSocket pongs do not renew that deadline.
Closing sends tracked key/button releases on the original VNC connection,
drains the relay, then clears and verifies X11 input. The real guest test showed
that XTest release alone did not clear a VNC-owned held button. Failed cleanup
blocks reuse and marks the desktop unreconciled for stop on revocation.

| Check | Result |
|---|---|
| Full plugin unit suite | **1,438 passed, 2 skipped, 0 failed** |
| App runtime/config tests | **7 passed, 0 failed** |
| Generated client and runtime checks | Passed |
| Plugin lint | Passed with existing warnings |
| Input cleanup Python helper | Syntax checked and executed against real guest |
| Real WebSocket control | Passed; zero Fetch reads |
| Real direct Fetch control | Passed |
| Real rejected-upgrade control | Passed; fresh Fetch viewer |
| Whole-team mock smoke | **46 passed, 6 failed** |
| Native Windows GUI/IME | User-run; not accepted by this session |

The real Chromium + TigerVNC fixture checks independent webpage click, focus,
text and Enter markers (including Chinese text), scaled pointer coordinates,
dragging with held modifiers, release on window blur and route disconnect,
manual resume, replaced-token rejection and give-back. Focus is confirmed by
the remote page before synthetic typing; local browser event dispatch alone
does not prove the remote input has focus. The desktop menu opened during the
observation test is dismissed before browser input. Each run removes only its
own labelled container, volume, browser and temporary home.

Unit coverage adds interactive/read-only RFB separation, fragmented events,
tracked key/button release, lease expiry, old-provider rejection, controller
exclusivity, snapshot/live exclusion, heartbeat expiry/renewal and asynchronous
channel close notification compatible with noVNC.

The generic mock smoke completed all 52 steps. Four `/api/bot` requests failed
with `ECONNRESET`; two dependent group checks also failed because the preceding
group result was absent. Initial model selection passed in this run. Sanitized
Undici diagnostics recorded failures 18–27 seconds into the affected requests,
so this run does not establish a simple idle-connection reuse cause. The
underlying defect remains unresolved; no production retries, `Connection: close`
workaround, skipped assertions or DSH patches were introduced. Its isolated
Linux bench was stopped and removed.

Run logs: `/tmp/cua-control-full.log`, `/tmp/cua-control-lint.log`,
`/tmp/cua-control-app-tests.log`, `/tmp/cua-control-ws.log`,
`/tmp/cua-control-fetch.log`, `/tmp/cua-control-blocked.log`,
`/tmp/cua-control-smoke.log`, `/tmp/cua-control-http-diagnostics.jsonl`.
The last file records only timestamps, method/path without query, socket IDs
and error codes; no headers, credentials or response bodies.

Local preview: `artifacts/ds-bot-0.2.5-cua.6.tgz` (1,057,977 bytes).
SHA-256: `02678fe45077b5b459de5b972f044c6a04ff3319c977c82cacc27c4c2e647555`.
Only the staged package version changes; source stays at 0.2.4. The archive was
extracted independently and compared with 91 host/shared/office/license files,
the generated client and the two new Broker helpers. All 22 runtime manifest
hashes match. Broker JavaScript lint passed as well. No user container was
stopped, replaced or removed by these fixtures.

## 2026-11-01: regression environment and stream latency

The unchanged Windows-mounted dependency installation reproduced the generic
mock smoke failure: **51 passed, 1 failed**. Dual-sided HTTP diagnostics captured
a 19,814 ms server event-loop stall overlapping the failed request's 19,591 ms
wait. No server request-start event occurred during that wait; the socket closed
as the stalled server resumed. This locates a failure before request handling,
rather than evidence that the model-selection mutation itself failed.

All 654 installed dependencies were reinstalled into a separate Linux directory
from the local npm cache. Versions and archive integrity values match exactly.
The same source checkout and full assertions then passed **all 52 steps**, with
zero recorded client connection errors; the largest recorded server stall was
4,234 ms. Both benches used separate Linux temporary data homes. No DSH patch,
HTTP timeout change, `Connection: close`, mutation retry or assertion bypass was
used. This supports the WSL test-environment remedy; it does not prove every
historical reset has the same cause or certify native Windows behavior.

The new opt-in `dev/http-diagnostics.mjs` records request/response timings, socket
closure and long event-loop stalls. It excludes credentials, queries and bodies,
does not add timeout listeners, releases completed-request listeners, and cannot
change an HTTP outcome if writing its log fails. The smoke runner now reports
which endpoint actually lost its response, the error code and elapsed time.
Regression tests cover log filtering and listener cleanup.

Final checks:

| Check | Result |
|---|---|
| Full plugin unit suite, Linux harness | **1,440 passed, 2 skipped, 0 failed** |
| Generated client and runtime checks | Passed |
| Plugin lint | Passed with existing warnings |
| Generic mock smoke, mounted dependencies | **51 passed, 1 failed** |
| Generic mock smoke, matching Linux dependencies | **52 passed, 0 failed** |
| Real streamed control + application pixel checks | Passed over WebSocket, Fetch and rejected-upgrade fallback |

Ten clicks per transport alternate a dedicated guest button's color. The
measurement runs from browser `mousedown` capture to the expected noVNC canvas
pixel; a separate guest HTTP marker verifies every click. The guest browser's
focus, Unicode input, Enter, held modifier/drag, blur/disconnect cleanup, manual
resume and replaced-token rejection checks remain enabled.

| Measurement (ms) | WebSocket | Fetch | Rejected upgrade → Fetch |
|---|---:|---:|---:|
| Cached guest startup | 2276 | 2314 | 2017 |
| Page navigation to first frame | 522 | 507 | 624 |
| Observation reconnect after service recovery | 400 | 466 | 555 |
| Controlled stream ready | 306 | 323 | 705 |
| Input-to-frame p50 | 44 | 76 | 62 |
| Input-to-frame p95 | 143 | 159 | 78 |
| Blur to independently confirmed input release | 180 | 198 | 247 |
| Disconnect to independently confirmed input release | 193 | 188 | 174 |

These are small local synthetic-page samples, not platform guarantees or model
turn latency. Fetch and rejected-upgrade measurements overlapped the independent
mock-team run. Nearest-rank p95 of ten samples is the largest sample.

Raw samples and dependency-comparison evidence:
`evidence/stream-performance.json`, `evidence/regression-environment.json`.
Instructions: `docs/dev/cua-verification.md`.
Logs: `/tmp/cua-next-tests.log`, `/tmp/cua-next-lint.log`,
`/tmp/cua-next-smoke.log`, `/tmp/cua-local-smoke.log`,
`/tmp/cua-next-stream-{websocket,fetch,blocked}.log`,
`/tmp/cua-next-http-*.jsonl`, `/tmp/cua-local-http-*.jsonl`.
Both benches were stopped; only their temporary homes and fixture resources
were removed. The matching Linux harness remains available for future checks.
This batch changes development/verification tooling, not the plugin payload;
the preceding `0.2.5-cua.6` preview remains the functional test package.


## 2026-11-01 — model gestures and chunked file transfers

Implemented public driver mappings for double-click (`count: 2`), key modifiers
and bounded drag gestures. File transfers now use 256 KiB chunks with a 16 MiB
file cap, SHA-256 validation, atomic no-overwrite publication, fixed export
snapshots, cancellation and expiry cleanup. The panel counts acknowledged bytes.
A background preview no longer silently drops a takeover click or file selection.

| Check | Result | Scope |
|---|---|---|
| Plugin unit suite | 1448 passed, 2 skipped, 0 failed | Includes strict gesture schemas, stale control/generation, cancellation, expiry, corrupted export and lost commit acknowledgements |
| Full Bot mock smoke | 52/52 passed | Isolated Linux test home and matching pinned DSH harness; no retry of actions |
| Real driver smoke | Passed | Independent Ctrl+A replacement, double-click and drag markers; 1 MiB model attachment import/export; lifecycle/checkpoint regression |
| Real panel file smoke | Passed | Browser File APIs to Host/Broker/guest; 1 MiB upload/download, in-flight chunk cancellation, no overwrite, no uncaught browser errors |
| Python filesystem tests | 7 passed | Empty and 16 MiB boundary, symlink/hardlink refusal, immutable export snapshot, checksum/order, swapped staging path |
| Desktop runtime packaging | 5 passed | Updated closed bundle inventory and standalone payload checks |
| Generated client/runtime and lint | Passed | Existing repository lint warnings remain |

The guest helper publishes from the checked open file descriptor, avoiding a
staging-path replacement between validation and linking. Lost final replies
remain uncertain and are never replayed. IPC frames remain bounded; raising the
file cap did not increase the Broker's 1 MiB stdin framing limit.

Windows Electron/IME and installer acceptance remain the user's test step. This
is not a real visual-model quality evaluation or completion of the full roadmap.
Only owned fixture containers, volumes, processes and test homes were removed.
Logs: `/tmp/cua-enhance-{tests,lint,smoke,real,panel,python,app}.log`.

Local preview: `artifacts/ds-bot-0.2.5-cua.7.tgz` (1,066,247 bytes).
SHA-256: `aac4d99d408f045ced503827e9a9e4174fbac0b79859c84d86e422c7f8086c4b`.
Only the staged package version changed; repository package version remains 0.2.4.
The final archive was independently extracted and all 23 runtime payload files
passed manifest verification. Its extracted Host provider and Broker started a
real desktop, returned a 1280×800 PNG, roundtripped the full **16 MiB** limit, and
removed an unpublished import on revocation; the old transfer identity was refused.
See `/tmp/cua-enhance-packed.log`. The final translation/build check also passed
105 focused tests; no additional functional changes followed those checks.

## 2026-11-01 — 200 MiB file limit

The UI, model descriptions, Host admission, Broker admission and guest helper now
accept files up to **209,715,200 bytes (200 MiB)**; one additional byte is refused.
Chunks remain 256 KiB and IPC framing limits are unchanged. The browser hashes
bounded slices incrementally with pinned @noble/hashes 2.0.1 (MIT, notice and license
included). Downloads hash received chunks without rereading the complete Blob.
Host attachment ingestion and model exports use a single sized output buffer
instead of retaining all chunks and then allocating another combined copy.

Snapshot preparation and commit have longer bounded waits; slow snapshot creation
starts its idle expiry after preparation. Long file operations preserve the same
control identity, and return to normal expiry afterward. Free-space reserve remains
16 MiB, independent of the 200 MiB file limit. No automatic replay was added.

| Check | Result |
|---|---|
| Plugin unit suite | 1452 passed, 2 skipped, 0 failed |
| Guest filesystem suite | 7 passed, including a complete 200 MiB write/commit and one-byte-over-limit refusal |
| Real browser panel | 200 MiB uploaded and downloaded; exact length and SHA-256 matched; cancellation and overwrite protection passed |
| Full mock Bot regression | 52/52 passed |
| Build, generated client/runtime checks, lint | Passed; existing lint warnings remain |
| Clean dependency install | `npm ci --ignore-scripts --legacy-peer-deps` passed in an isolated Linux directory |
| Extracted preview | All 23 runtime files verified; model transfer roundtrip, 200 MiB admission and 200 MiB + 1 refusal passed |

Preview: `artifacts/ds-bot-0.2.5-cua.8.tgz`, 1,075,334 bytes.
SHA-256: `cf6120548b14838d0e0b739fe70cd5e6be59099ba6b1eaa5ee162b35f34350fc`.
Only the staged preview version changes; source version remains 0.2.4.
Logs: `/tmp/cua200-{panel,packed,tests,python,smoke,build,lint,dependencies}.log`.
The isolated mock bench and owned test containers/volumes were stopped and removed.
Windows desktop acceptance remains separate; these real tests ran under Linux/WSL.

## 2026-11-01 — Manual transfer-file cleanup

Added explicit file deletion while the user holds desktop control, with a
confirmation bound to the desktop generation, control ticket, file name and
listing version. Listing reports visible regular-file bytes and runtime free
space. The 200 MiB transfer limit is unchanged; cleanup also accepts larger
regular files. Model tools do not expose deletion.

| Check | Result |
|---|---|
| Plugin unit suite | 1455 passed, 2 skipped, 0 failed |
| Full mock Bot regression | 52/52 passed; isolated bench stopped and removed |
| Guest filesystem suite | 10 passed, including existing full 200 MiB commit and new cleanup cases |
| Real browser panel | 1,048,607-byte roundtrip, cancel and overwrite checks passed; cancelling deletion preserved bytes, changed file was refused, fresh confirmation removed it and refreshed the list |
| Authorization and failure checks | Missing/stale control, stale generation, invalid name/version refused before dispatch; active transfer blocks deletion; lost reply is not retried |
| Build, generated client/runtime checks, lint | Passed; existing lint warnings remain |
| Extracted preview | All 23 runtime hashes and generated client matched; 3 cleanup filesystem tests passed against the extracted helper |

Deletion uses a no-follow directory descriptor and unlinks only the selected
flat name. Metadata checks detect stale listings before unlink; they are not an
atomic inode compare-and-delete guarantee against concurrent guest renaming.
The link-swap test verifies that the destination of a substituted symlink survives.

Preview: `artifacts/ds-bot-0.2.5-cua.9.tgz`, 1,076,767 bytes.
SHA-256: `e0d92c54a29f3aa1ba712cdf4ee790d63444bfa9c3498ac9829443cb23984ef8`.
Source version remains 0.2.4. Logs: `/tmp/cua9-{tests,python,panel,packed,build,lint,package,smoke}.log`.
Owned test containers and volumes were removed; existing user containers were left untouched.
Windows desktop acceptance remains with the user.

## 2026-11-01 — Native desktop service recovery

The panel now starts an explicit background recovery of the shared native Broker.
It invalidates all desktop viewers, control tickets and observations, drains
cancelled operations, retires the previous Broker, checks the original engine
identity, then stops and reconciles each registered desktop. Homes, checkpoints
and unknown receipts survive; desktops require an explicit start afterward.
Old-window consent is rejected and ordinary polling never reconnects the Broker.

| Check | Result |
|---|---|
| Plugin unit suite | 1463 passed, 2 skipped, 0 failed |
| Full mock Bot regression | 52/52 passed; isolated bench stopped and removed |
| Final Broker tests | 13 passed, including retirement/cancellation, engine identity mismatch and interrupted lifecycle refusal |
| Host/API/UI recovery | Cross-Bot invalidation, pending input to unknown, stale consent/control rejection, partial failure blocking, explicit retry and management-only endpoint passed |
| Real browser and two guests | Killed only the fixture Broker; cancelled then confirmed recovery in the panel; both desktops stopped; old ticket refused; explicit restart retained distinct home markers |
| Existing file panel regression | Chunked roundtrip, cancel, no overwrite and confirmed file cleanup passed |
| Build, generated client/runtime checks, lint | Passed; no new lint warnings in changed recovery files |
| Extracted preview | All 23 runtime hashes and generated client matched; extracted Host provider and Broker completed two native recovery handshakes |

Legacy Windows WSL stdio recovery remains unavailable. A crash with an
unconfirmed lifecycle operation refuses in-place replacement because engine
helpers may not have settled; restart DSH and inspect lifecycle recovery.
Tests ran under Linux/WSL with native Node; Windows Electron GUI acceptance
remains with the user.

Preview: `artifacts/ds-bot-0.2.5-cua.10.tgz`, 1,080,121 bytes.
SHA-256: `7bfc04a2aba1f18e0d06cb38ba1919ec5984d01f141942d0677250ec1d5266cd`.
Source version remains 0.2.4. Logs:
`/tmp/cua10-{tests,broker-final,panel,build,lint,package,smoke}.log`.
Both owned guest containers and volumes were removed. Existing user containers
were left untouched.

## 2026-11-01 — Prebuilt image release evidence and promotion

The workflow now separates the build/publish runner from anonymous download on a
fresh runner. A promotable candidate binds repository, full commit, normalized
recipe, tested image ID, registry digest and hashes of build/pull/smoke/inventory
evidence. Explicit promotion verifies these against the current recipe before
atomically changing the source lock. This is consistency checking, not a signed
provenance claim; artifacts must come from a trusted workflow run.

| Check | Result |
|---|---|
| Plugin unit suite | 1470 passed, 2 skipped, 0 failed |
| Full mock Bot regression | 52/52 passed; isolated bench stopped and removed |
| Release tests | Dirty/wrong source, stale recipe, changed evidence, substituted image, invalid registry reference, missing smoke coverage and mismatched inventory rejected; promotion leaves recipe identity stable |
| Installed loader fixture | Real manifest/lock/loader with engine boundary fixture: fixed digest pull, tested ID enforcement, retained pinned images, registry failure and cancellation passed |
| Real native setup smoke | Existing cached image; screenshot, file roundtrip, checkpoint, stop and restart passed; structured report written after owned-resource cleanup |
| Build, generated files and lint | Passed; no new warnings in changed files; runtime CLI lint passed |
| Workflow | YAML parsed; actual remote workflow was not executed |
| Extracted preview | 23 runtime hashes and client matched; extracted loader validated the actual local engine and immutable image |

One full-suite invocation omitted the Linux esbuild override and failed on the
existing Windows native dependency. It was rerun with the isolated Linux binary;
the successful result above includes all tests. The user's dependencies were not
replaced.

Preview: `artifacts/ds-bot-0.2.5-cua.11.tgz`, 1,080,868 bytes.
SHA-256: `fef81280db118158317d9c664163b6c452c0b5a70574672109d0164c0f62f28f`.
Source version remains 0.2.4. Logs:
`/tmp/cua11-{tests-final,image-final,native-smoke,smoke,build,lint-final,runtime-lint,package}.log`.

No image was pushed or made public. The source and preview locks still have no
published reference; first-time setup therefore still builds locally. Actual
GHCR publication, independent anonymous pull, clean-engine first download and
Windows Desktop acceptance remain unverified. The release procedure is in
`docs/dev/cua-image-release.md`. No user desktops or DSH data were modified.

## 2026-11-01 — Native file selection and multiple uploads

The file picker is now a visible button backed by the browser/Electron native
multiple-file input. Selecting local files works before takeover; uploading is
an explicit separate operation requiring current desktop control. The selection
is validated before any file is read or sent. Each file is limited to 200 MiB,
with no 200 MiB limit on the sum of a batch. Transfers run serially, show each
file's result and stop the remaining queue on cancellation or failure.

| Check | Result |
|---|---|
| Plugin unit suite | 1475 passed, 2 skipped, 0 failed |
| Selection/UI checks | Picker enabled before takeover, multiple attribute, selection sends no files, cancelled picker retains selection, oversized selection disables upload |
| Batch checks | Per-file boundary and larger batch totals admitted; over-limit byte, duplicate names and invalid names rejected before reads; serial commit, cancellation and lost receipt refusal passed |
| Real browser → Host → guest | Actual filechooser event; 1,048,607-byte roundtrip with matching SHA-256; native multi-selection uploaded Unicode-name and empty files |
| Existing file operations | Cancelling a batch left no partial file and never started the next file; no-overwrite and confirmed deletion checks passed |
| Build, generated client/runtime and lint | Passed; no new warnings in changed files |
| Extracted preview | All 23 runtime hashes, generated client bytes and new upload UI strings verified |

An initial browser test had an ambiguous text locator after errors appeared in
both the queue and global alert. The locator was scoped to the alert and the
complete browser scenario passed on rerun. Owned test resources were cleaned.
No Host or Broker behavior changed, and the general Bot smoke was not repeated.
The previous full-size 200 MiB transfer evidence remains applicable; this round
tested its per-file boundary without repeating the full-size transfer.

Preview: `artifacts/ds-bot-0.2.5-cua.12.tgz`, 1,081,818 bytes.
SHA-256: `6c71e99a6f4e483215b19afe21e74e38fa657dbc51ad3de36495a2f22f87e159`.
Source version remains 0.2.4. Logs:
`/tmp/cua12-{targeted,tests,panel,build,lint,package}.log`.
Browser tests ran on Linux/WSL; Windows native dialog acceptance remains with
the user. No user DSH data or existing desktops were changed.

## 2026-11-01 — High-priority runtime and resource delivery

Windows setup now records approved fixed system-install steps, the Windows boot
identity, cancellation and uncertain installer outcomes. Reopening DSH can resume
approved preparation after a reboot or engine startup, without replaying uncertain
installers. The Windows command/boot/retry/cancellation tests use injected fixtures;
no system installer or restart was executed on the user's Windows machine.
Windows App Installer remains a prerequisite for the winget engine-install step.

The desktop resource panel persists host-wide running/idle/warning settings with
revision fencing and measures real guest disk usage. Periodic scans do not refresh
idle activity, and failed or stale readings are labelled. New-home hard quotas are
limited to Podman rootful/XFS: the kernel probe requires EDQUOT, all volume metadata
is checked and restore/upgrade preserve the quota. Docker ordinary named volumes
remain warning-only. Actual Podman/XFS enforcement is not certified in this Linux
Docker environment; backups and root layers are outside the per-home quota.

Validation before publication:

- Unit suite: 1496 passed, 2 skipped, 0 failed.
- Build, generated client/runtime checks and lint: passed (existing warnings).
- Real browser/Host/Broker/guest: resource settings saved and real disk usage read;
  1,048,607-byte file roundtrip SHA-256 matched; multiple Unicode/empty-file selection,
  cancellation, no-overwrite and confirmed deletion passed; no browser exceptions.
- Isolated mock Bot smoke: all 52 steps passed; owned processes and data cleaned.
- Archive tests: current-recipe packing, installed loader, substituted image ID,
  malformed manifest, checksum/length errors, low disk, cancellation and cleanup.
- Quota tests: unsupported engines, kernel-probe refusal, interrupted creation,
  foreign-resource cleanup refusal and exact metadata; existing home never resized.

The archive workflow builds from a committed recipe, publishes bounded parts,
verifies anonymous download on a second runner and repeats the actual desktop
smoke. Its publication outcome is recorded separately; these local checks alone
are not evidence of an available public image. Logs: `/tmp/cua13-{tests-final,
recheck,panel,smoke,build-final,lint-final}.log`.

Publication completed in GitHub Actions run `41285990416`:

- Source: `c4ac3e9d2b713c7ca492b6258ef1ecd8f5fbb4cf`.
- Publish, independent fresh-runner anonymous download, desktop smoke and result
  jobs all succeeded. Public preview release contains three archive parts,
  627,774,939 compressed bytes, manifest, lock, build/smoke evidence and inventory.
- Verified image: `sha256:3da1065e532b906f78b404df1909e7a17722cdd239acfcb5bda9202271ce3c4a`.
- Manifest SHA-256: `8a583718e830d2f85bbc518949b82969dd172be7005480bc42c9fc6252188f4f`.
- Evidence commit: `47f8ef37b7d87a043041015989c4a7062c093a6e`; its parent and sole
  changed lock file were checked before import. Current recipe equals its recipe.
- The source and bundled lock now use the actual published archive. Existing
  installations keep their old image. No GHCR package or signed app was released.
- After importing the real lock and adding the engine-reboot regression, the unit
  suite passed 1497 tests, skipped 2 and failed 0; build/check/lint passed.

The fixed `RedHat.Podman` package identifier was checked against the official
Microsoft winget manifest directory. Windows install commands themselves remain
fixture-tested; no WSL/engine installation or reboot was performed locally.

Final preview: `artifacts/ds-bot-0.2.5-cua.13.tgz`, 1,093,176 bytes.
SHA-256: `23b3eb582c9a82e753654efb848853c85dd6c9309de51b69c136310977e4ccf3`.
Independent extraction verified the runtime manifest, installed setup loader,
published image lock, current host modules and exact generated client bytes.
Only the staged package version is 0.2.5-cua.13; source remains 0.2.4.
Final logs: `/tmp/cua13-final-{build,tests,lint}.log`,
`/tmp/cua13-windows-final.log` and `/tmp/cua13-package.log`.

## Large checkpoints and image updates — 2026-11-01, cua.14

The two selected high-priority features are implemented. Checkpoints default to
20 GiB (configurable 1–1024 GiB), stream copy/hash work, report background progress
and support cancellation. The registry accepts the same capacity range; single
file uploads remain 200 MiB. Interrupted publication preserves its recovery intent.

Image checks accept compatible evidence commits in the repository pinned by the
shipped release lock. Verified downloads register immutable pins without changing
running desktops. Pins survive setup and Broker restart. Upgrade confirmation
captures the exact generation/image and retains the previous image/home pair.
The public GitHub asset API is a checksum-equivalent fallback for blocked release
pages. Explicit profiles continue to manage their runtime images manually.

Validation evidence:

- Real React/Host/Broker/guest smoke: 256 MiB backup survived panel reload; restore
  matched SHA-256 and reverted a changed marker while retaining the previous home.
- Real local archive fixture: Docker export, compression, manifest/part checks,
  engine load, compatibility checks and registration completed while the original
  desktop remained running. Confirmed upgrade, explicit start and rollback all
  preserved the 256 MiB file; no uncaught browser exceptions.
- Public evidence discovery returned source `c4ac3e9d2b713c7ca492b6258ef1ecd8f5fbb4cf`
  and evidence `47f8ef37b7d87a043041015989c4a7062c093a6e`. The public manifest was
  retrieved through the official asset API. The full public archive download was
  cancelled after slow partial transfer and its temporary file was removed; this
  run does **not** claim full live public download acceptance. The prior clean CI
  publication/anonymous verification remains recorded in cua.13.
- File panel regression: native multi-selection, Unicode/empty files, byte/hash
  roundtrip, cancellation, overwrite refusal, changed-file deletion fencing and
  confirmed deletion passed.
- Isolated DSH mock smoke: 52/52 steps passed, own processes/data cleaned.
- Python filesystem suite: 16 passed, including >200 MiB roundtrip, manifest bounds,
  content/identity corruption, low disk, symlink and transfer boundaries.
- App runtime packaging/verification suite: 5 passed; closed inventory now has 24
  files, including the streamed checkpoint subprocess reader.

Windows GUI and system installation were not exercised. The 20 GiB default and
1 TiB configurable maximum are policy bounds, not claims of endurance tests at
those capacities. Prepared images retain four upgrade slots; pruning remains
manual and must preserve images referenced by retained homes.

Logs: `/tmp/cua14-final-check.log`, `/tmp/cua14-storage-fixture.log`,
`/tmp/cua14-files-smoke.log`, `/tmp/cua14-mock-smoke.log`,
`/tmp/cua14-python.log`, `/tmp/cua14-app-test.log`.

Final unit suite: **1510 passed, 2 skipped, 0 failed**. Build, generated client and
runtime checks, lint and scoped diff checks passed (existing lint warnings remain).
Preview: `artifacts/ds-bot-0.2.5-cua.14.tgz`, 1,102,475 bytes.
SHA-256: `240af44566a5f28409009d1f2143d85396ae5414e69758c3b02cea8163e5a196`.
Independent extraction verified all 24 runtime files, the installed setup loader,
new update/storage modules and exact client bytes. Only the staged package version
is 0.2.5-cua.14; source remains 0.2.4. Packaging log: `/tmp/cua14-package.log`.

## cua.15 — reference-aware cleanup and resumable downloads

- Unit coverage: desktop/default/rollback/checkpoint/container/volume references,
  unknown ownership and image provenance, stale engine/registry/resource confirmation,
  deletion failure, missing unused pins after interruption, manager exclusion,
  persisted allowlist removal and Broker reconnect.
- Download coverage: cancelled partial Range continuation, complete-part rehash/reuse,
  checksum corruption, ignored/invalid Range, official asset API Range propagation,
  release replacement and cache clearing/exclusion. Existing archive validation remains.
- `dev/computer-cleanup-smoke.mjs`: real React panel, host manager, native Broker and
  Docker. Creates its own test desktop/image/orphan; explicit confirmation deletes
  only the test orphan and preserves a marker inside the still-running desktop.
  This engine contains pre-existing foreign legacy storage with no image label, so
  image deletion correctly remained blocked. Real engine image deletion in an engine
  without that ambiguity is not claimed by this run; deletion/slot persistence and
  reconnect behavior are covered by unit and Broker IPC tests.
- `dev/computer-download-smoke.mjs`: real loopback HTTP transfer and Docker load.
  Interruption retained 131072 bytes; retry sent Range from that offset, verified the
  complete archive and restored the exact image ID. Cache was removed after import.
  The isolated small test image tests transport/import only, not guest compatibility.
- Public release download and Windows native GUI are not retested by these fixtures.
  No user desktop, legacy volume or engine configuration was modified. Both scripts
  clean their own images, containers, volumes, temporary teams and servers.
- Logs for this local run: `/tmp/cua15-final-check.log`, `/tmp/cua15-broker-test.log`,
  `/tmp/cua15-cleanup-smoke.log`, `/tmp/cua15-download-smoke.log`,
  `/tmp/cua15b-mock-smoke.log`, `/tmp/cua15-app-test.log`.
  The earlier `cua15-mock-smoke.log` run used an occupied mock port and was stopped;
  the isolated rerun on free ports 3315/8815 passed all 52 steps and was stopped.
- Final verification: 1524 unit tests passed, 2 skipped, 0 failed; client/runtime
  generation checks and lint passed (existing warnings). App runtime/patch tests
  passed 7/7; isolated mock DSH smoke passed 52/52. The unpacked `0.2.5-cua.15`
  plugin verifies all 25 runtime files and loads the installed setup/cache modules.
  Artifact: `artifacts/ds-bot-0.2.5-cua.15.tgz`, 1,108,363 bytes,
  SHA-256 `ed57099038e8200770da12fc49d047c8b08b6516560b65602fe5a231fdaaefaa`.

## cua.16 — storage evidence, desktop policies, portable backups and task queue

- Legacy verification tests cover missing image labels, registered ownership,
  changed engine/creation metadata, mismatched owners and stale inventory tokens.
  Volume labels are never modified. Real user legacy storage remains untouched.
- Policy tests cover stopped/generation requirements, CPU/memory admission and
  retaining settings when grants change. Disk tests cover protective stop,
  blocked restart, cleared protection after space recovery and rejection of
  public portable requests containing host paths.
- Portable tests cover ordered bounded chunks, ownership, explicit confirmation,
  interrupted uploads, download/discard, roundtrip content/links, corrupt/truncated
  archives, unsafe paths/parents/checksums and wrong images. The format checks
  integrity, not authenticity, encryption, xattrs or a complete machine snapshot.
- Queue tests cover single dispatch, explicit results, pause/resume, uncertain
  delivery, restart, unrelated turns, stale attempts/generations, delayed delivery
  cancellation and real public DSH AgentLoop screenshot/result completion.
- `dev/computer-management-smoke.mjs` passes on real Docker: 1 CPU/1 GiB RAM,
  offline refusal, exact-domain HTTPS success, rejection of other domains,
  metadata IP, direct outbound connections and external guest DNS; reverting to
  open mode removes the proxy/network. Streamed backup import restores the marker
  into a new home and keeps the previous home. A corrupt import is refused; recovery
  removes staging and preserves the current home. This uses only a temporary team and
  removes its own labelled resources.
- `dev/computer-management-ui-smoke.mjs` passes with real Chromium/React and the
  actual host managers plus a fake desktop provider: 65 MiB export as two numbered
  downloads (including an explicit fallback after a denied native picker),
  reverse-order multi-file selection, chunked upload, explicit import,
  CPU/RAM confirmation, queue persistence/pause/cancel and panel reload. No browser
  errors. This validates the fallback download UI; native Windows save-picker and
  Electron GUI acceptance are not claimed.
- Isolated mock DSH regression passes all 52 steps and stops both test processes.
  App runtime/patch tests pass 7/7; Python file/checkpoint/portable/proxy tests pass
  20/20. Runtime payload now contains 30 verified files. Logs:
  `/tmp/cua16-real.log`, `/tmp/cua16-ui.log`, `/tmp/cua16-loop.log`,
  `/tmp/cua16-smoke.log`, `/tmp/cua16-app.log`, `/tmp/cua16-python.log`.
- No Windows engine configuration or user desktop/container/volume was changed.
  Podman restricted-network mode is explicitly unsupported. Existing Podman/XFS
  quota enforcement retains its actual kernel probe; Docker protection remains
  sampled admission/stopping, not a hard disk limit. Signed installer, real Podman,
  Windows GUI and cross-browser-version acceptance remain outside this run.

Final cua.16 verification: **1541 unit tests passed, 2 skipped, 0 failed**.
Generated client/runtime checks and lint passed (existing warnings remain).
Artifact: `artifacts/ds-bot-0.2.5-cua.16.tgz`, 1,132,762 bytes.
SHA-256: `8bdb50e8a4eff2bcde9ae111961d840f427009c3815e6f9135cb4fc01bcac0f2`. Independent extraction verified all 30 runtime files,
the installed loader, new host modules and exact generated client bytes.
Only the staged package version is 0.2.5-cua.16; source remains 0.2.4.
Packaging log: `/tmp/cua16-package.log`.

## cua.17 — one-time scheduled desktop tasks

- Optional absolute `runAt` timestamps persist in the desktop registry. Times
  must be numeric integers in the next 366 days; explicit null, strings and
  malformed values are refused rather than queued immediately.
- Queue tests reopen the actual store from disk, advance a controlled clock,
  check no early/duplicate dispatch, verify ready work bypasses future entries
  and due tasks sort by time, and retain pause/cancel/unknown-result fencing.
- Real Chromium/React with actual host managers and a fake desktop verifies
  Shanghai and Los Angeles time entry, saved epoch values, page reload, no
  premature delivery and cancellation. The existing portable-backup fallback,
  multi-part import and resource-setting regression also passed.
- Full unit suite: **1544 passed, 2 skipped, 0 failed**. Client/runtime generated
  checks and lint passed (existing warnings). A Windows mount rename lock
  prevented ordinary runtime directory replacement; runtime files were generated
  in a temporary directory, verified, copied with the manifest last, and checked
  again with the repository verifier (30 files).
- Logs: `/tmp/cua17-tests.log`, `/tmp/cua17-ui.log`, `/tmp/cua17-lint.log`.
  Windows native GUI and real vision-model evaluation were not performed.
  Times are earliest eligibility, checked on the existing 30-second timer;
  this does not wake the host, start stopped desktops or schedule repeats.
- Isolated mock DSH smoke passed **52/52** and stopped its mock/Web processes;
  temporary team data was removed. Log: `/tmp/cua17-smoke.log`.

Preview: `artifacts/ds-bot-0.2.5-cua.17.tgz`, 1,133,948 bytes.
SHA-256: `489672725c5d136f1d9720bee1f8f0f3b5caa85e133017bd117011187f8a304e`.
Independent extraction verified all 30 runtime files, installed setup loader,
the host task implementation and generated client. Only the staged package version
is `0.2.5-cua.17`; source remains `0.2.4`. Log: `/tmp/cua17-package.log`.
