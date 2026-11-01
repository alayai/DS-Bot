# Computer runtime — development preview

This directory adds an optional, locally managed Linux desktop to the DS Bot
plugin. DSH remains the agent loop. The plugin calls a private IPC Broker, which
uses Docker (or the experimental Podman adapter) to run Cua Driver inside each Bot's container.

This is a development checkpoint of the [CUA plan](../docs/plans/2026-10-31-cua-computers.md),
not a release or a completed MVP. The plan's checklist and VALIDATION.md record
implemented behavior and outstanding work without a completion percentage. It includes the desktop panel and input, YOLO,
chat file attachments, persistent human-help requests with own/group-chat resume,
resource limits, idle shutdown, stopped-home checkpoints/restore/recreate, old-home
rollback, explicit storage/history cleanup, and journaled interrupted-operation recovery.
A runtime check/build CLI and a separately distributable source payload are included.
Desktop builds now carry that payload outside the asar and can opt in with
`broker.bundled: true`, including Windows-to-WSL path resolution.
Windows GUI acceptance, network policy, signed installer acceptance,
cross-browser-version compatibility and complete disk quotas remain incomplete.

## Prepare from the installed plugin

CUA plugin builds include a verified runtime payload. On Windows x64, start
Docker Desktop in Linux-container mode; on Linux x64, start local Docker.
Open a Bot's **Private desktop**, then choose **Prepare and start**. The Host
checks its local engine, downloads the pinned archive, saves the exact engine and
image identity, starts an observe-only desktop, and waits for a real screenshot.
No source checkout or separate WSL Node installation is needed on this path.

Progress and bounded, redacted logs are saved under the plugin's own
`computers/setup.json`. Closing the panel does not cancel the job. A Host restart
reconciles approved early preparation steps and continues when the saved boot/engine
conditions are met; uncertain desktop mutations remain interrupted for review.
**Retry preparation** checks existing state before continuing. Cancellation retains reusable image layers and desktop data.
The selected engine is pinned even if image preparation fails. A changed Docker
engine identity is refused instead of silently creating desktops in another store.

An explicit `computer.enabled: false` disables the setup flow. Explicit provider
configurations keep precedence; pre-existing Computer records without a saved
setup configuration require their original provider settings. Setup never edits
the user's DSH profile. The operation runs on the DSH server, not necessarily the
machine where its browser is open.

Windows uses a native Node/Electron Broker and a local Docker named pipe.
The **Install desktop environment** action requests explicit confirmation before
running fixed WSL and winget engine-install commands on the DSH host. Windows App
Installer must be available. Complete the system prompts and restart Windows if
requested; DSH never initiates a reboot. Reopen DSH to resume approved preparation.
Cancelling cannot undo an elevated installer already running. The engine selector
also offers **Podman (experimental)**.
On Windows, **Prepare Podman machine and desktop** explicitly creates/starts the
fixed `ds-bot` machine (rootful, Linux x64) before preparing the image. It does not
install Podman or Windows features, restart Windows, remove a machine, or change
the default Podman connection. If system setup requires a reboot, reopen DSH and
retry after the system setup finishes. Existing non-DS-Bot machines must be
managed from Podman Desktop. Linux Podman requires a running rootful local Unix
socket service. Both paths require cgroup v2 for resource limits.

The adapter pins the machine name/creation identity, SSH key path, loopback
endpoint and engine store. It rejects remote connections, rootless engines,
changed stores and incompatible isolation settings. Inspect field normalization
does not fill in missing resource or security settings. A configured engine cannot
be switched from the selector; migration remains a separate operation. Real
Podman lifecycle acceptance is still outstanding; Docker remains the tested path.

The source lock pins a published GitHub Release archive, a tested immutable image
ID and the desktop recipe. The installer verifies a bounded manifest and every
part's size/SHA-256 before loading the archive; it does not extract it on the host.
A clean independent CI runner verified anonymous download and exercised the
actual desktop. Download failures stay visible instead of changing the source.
Existing desktop image pins are retained. The GHCR candidate workflow remains an
alternative delivery route; see `docs/dev/cua-image-release.md`. No signed desktop
installer release was made by the image workflow.

## Supported development setup

- Linux x64, Node.js 22, and a local Docker Engine Unix socket.
- A source checkout and the DSH harness pinned by `ds-bot/dev/harness/package.json`.
- The immutable local image built below. The Broker never pulls an image.
- Image-capable models for Computer observations; tests need no model key.

Existing Windows source configurations can still use a WSL distribution with Linux Node.js and
Docker. The native Windows Node → WSL → real guest path has its own smoke test;
this is separate from Linux-only testing. Remote Docker/Podman, ARM, native
Windows guests and packaged Windows installers remain outside this checkpoint.

Build from the repository root:

```sh
docker build --platform linux/amd64 \
  -t ds-bot-cua-probe:0.37.0 computer-runtime/desktop
docker image inspect ds-bot-cua-probe:0.37.0 --format '{{.Id}}'
```

The base image digest, wheel version and wheel SHA-256 are recorded in
`runtime.lock.json`; pip verifies the hash through `desktop/requirements.txt`.
The build uses the registry and Python package index. **Running desktops use
the engine bridge** (`bridge` on Docker, `podman` on Podman) and can reach the
internet. Egress is not filtered. Host networking stays rejected. An older
container created with `--network none` is replaced on the next start; its
volume is kept.

The Broker requires the resulting `sha256:…` **local image ID**, not the tag or
the base-image manifest digest. It verifies image labels, Bot/Computer labels,
non-root execution, resource limits, network, capabilities, volume identity and
absence of host bind mounts before reuse. This is a compatibility and boundary
check, not image provenance attestation or a complete supply-chain audit.

## Installed plugin but no desktop entry

The plugin enable switch and desktop setup are separate. Earlier CUA builds
hid **Private desktop** entirely while the runtime was disabled. Updated builds
keep the entry in Bot details/settings and offer **Prepare and start**. A profile
that explicitly sets `computer.enabled: false` still disables preparation.
The entry belongs to an individual Bot, not the plugin-management page or a group.
Installing a package does not download an image or configure/start the Broker.
A source code fix also does not update a package already installed in DSH; install
the rebuilt package and restart that DSH host before checking its entry.

## Configure the plugin

Add this entry to a DSH profile patch, substituting the absolute Broker path and
the actual image ID. Use a dedicated test profile while evaluating it:

```yaml
- id: bot
  config:
    computer:
      enabled: true
      maxRunning: 2
      idleStopMs: 900000
      broker:
        entrypoint: /absolute/path/to/ds-bot/computer-runtime/broker/main.mjs
        image: sha256:REPLACE_WITH_THE_64_HEX_LOCAL_IMAGE_ID
```

DSH config overrides replace the entry's complete config. Preserve any existing
Bot settings when adding this block. The `entrypoint` is an operator-controlled
executable path; it is never accepted from model arguments or the web channel.
`computer.enabled` defaults to false. Disabled installations do not register
Computer tools, fork the Broker or start containers.

### Management API

The panel uses the existing authenticated `POST api/bot` channel. Payloads cannot change the Broker executable, image,
Docker endpoint, host mounts or shell arguments.

| Endpoint | Payload | Result |
|---|---|---|
| `computer-state` | `{}` | Registry revision and Computer statuses |
| `computer-bind` | `{botId, expectedRevision, grant: "off" \| "observe" \| "operate", executionPolicy: "assisted", approvalMode?: "required" \| "yolo"}` | Stable Computer identity and generation |
| `computer-start` | `{botId, expectedGeneration}` | Updated state; starts the assigned desktop |
| `computer-stop` | Same | Revokes input and stops the container; keeps its home |
| `computer-takeover` | Same | Revokes automatic authority; returns a private `controlToken` for this window |
| `computer-release` | `{botId, expectedGeneration, controlToken}` | Ends the pause; a fresh model observation is required |
| `computer-preview` | `{botId, expectedGeneration, controlToken?}` | Bounded PNG, dimensions and one-use human frame ID |
| `computer-input` | `{botId, expectedGeneration, controlToken, frameId, requestId, actions}` | One human action, with a non-replayable receipt |
| `computer-handoff-answer` | `{botId, requestId, outcome: "done" \| "skip", controlToken?}` | Claim an answer and resume the current part of the original own/group chat |
| `computer-storage-start` | `{botId, expectedGeneration, method, checkpointId?, targetImage?}` | Start a background storage task; progress and result appear in `computer-state` |
| `computer-storage-cancel` | `{botId, jobId}` | Cancel only the matching storage task; interrupted writes retain recovery intent |
| `computer-image-state` / `computer-image-check` | `{}` | Read status / check approved compatible releases |
| `computer-image-download` | `{candidateId}` | Download, verify and register the checked image without upgrading a desktop |
| `computer-image-cancel` | `{jobId}` | Cancel only the matching image check/download |
| `computer-checkpoint` | `{botId, expectedGeneration}` | Save a verified checkpoint of a stopped home |
| `computer-restore` | `{botId, expectedGeneration, checkpointId}` | Stage and verify a new home, then change generation; retains the old home |
| `computer-rollback` | `{botId, expectedGeneration, homeRevision}` | Switch to a retained home; `null` selects the original home; changes generation |
| `computer-delete-home` | Same | Delete only a retained previous home, never the current home |
| `computer-delete-checkpoint` | `{botId, expectedGeneration, checkpointId}` | Delete a saved checkpoint and free a backup slot |
| `computer-prune-journal` | `{botId, expectedGeneration}` | Clear this Computer's action/help receipts while stopped; invalidate old generations |
| `computer-recover` | Same | Reconcile an interrupted storage operation, retaining the authoritative home |
| `computer-recreate` | `{botId, expectedGeneration}` | Save a checkpoint, then remove the stopped container; next explicit start recreates it |
| `computer-files` | `{botId, expectedGeneration, controlToken, operation, name?, data?}` | Flat files in `/home/cua/DSBot`; 200 MiB maximum via 256 KiB chunks. Legacy read/write remains capped at 256 KiB |

Read `computer-state` before binding and use its current revision. Use the
generation returned by binding for lifecycle requests. Rebinding an existing
Computer changes its generation and revokes old input. Main Bots cannot assign
or escalate their own grant through a model tool.

For example, from an already authenticated DS Bot page:

```js
async function computer(endpoint, payload = {}) {
  const response = await fetch('api/bot', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
const state = await computer('computer-state')
const assigned = await computer('computer-bind', {
  botId: 'REPLACE_WITH_EXISTING_BOT_ID',
  expectedRevision: state.revision,
  grant: 'operate',
  executionPolicy: 'assisted',
})
await computer('computer-start', {
  botId: assigned.botId,
  expectedGeneration: assigned.generation,
})
```

There is no automatic startup on observation, unbind/data-purge endpoint or
model-accessible lifecycle tool in this batch. Stopping the container preserves
the grant; revoking model input can be done by rebinding with `grant: "observe"`,
or pausing it through takeover. Deleting a non-Main Bot stops and archives its
Computer while retaining the named volume. Duplicating a Bot does not duplicate
its Computer or browser login.

### Model tools

| Tool | Behavior |
|---|---|
| `computer_status` | Reports the assigned Computer without starting it |
| `computer_observe` | Saves the real PNG through DSH's attachment API and returns an observation ID |
| `computer_act` | Sends one click (including double-click), text, key chord, drag or scroll action; requests approval unless the user enabled YOLO |
| `computer_release` | Releases the executing Session's lease |
| `computer_files` | Lists the desktop transfer folder |
| `computer_import` | Imports a file already attached in this Session's current context; requires operate access and approval unless YOLO |
| `computer_export` | Returns a desktop file as a real DSH file attachment in chat |
| `computer_request_takeover` | Pauses automatic access, persists a human-help request and concludes the turn |

Pixel coordinates refer to the **DSH-normalized image**, not a guessed screen
resolution. Scroll `deltaY` is signed line steps, from -50 to 50 excluding zero.
Text is limited to 4000 characters. Keys are Enter, Tab, Escape, Backspace,
Delete, arrows, Home, End, PageUp, PageDown and Space; modifier chords are not
enabled.

An action needs a current observation in the same Bot Session and turn, an
unexpired lease, an image-capable model, an `operate` grant, and (by default) explicit
`allowed-once` approval. The user may select **YOLO — no approval** in the
**CUA approval mode** selector to skip that confirmation for this desktop.
The mode persists across restarts. Existing records default to `required`;
YOLO does not change host tool permissions, networking or the frame/lease checks. Execution leases expire after 30 seconds without renewal;
expired leases require a new observation. The lease renews while approval is pending. The plugin
captures again before input in both modes and refuses if the PNG changed. Animations,
native hover effects and caret blinking can therefore require a new observation
and, in the default mode, approval. No input is sent on this refusal.

The pinned driver's desktop input result may say `unverifiable`. The Broker
preserves this as `unknown`, even when transport dispatch succeeded. **Do not
replay it.** Observe and verify the intended effect. A receipt is not proof that
a webpage submitted a form or that a file was saved.

## Human help, resource limits and recovery

A help card appears in the originating own or group chat and in the desktop panel.
**Open desktop → Take control → I'm done** answers it; **Skip** also answers it.
**Give back to Bot** only releases control. Pending requests survive restart, while
control tokens do not. Group answers follow that Bot's current part in the same
group. Ordinary user messages or user cancellation invalidate associated open
requests; deletion, group departure or a changed desktop generation cannot resume
an old task. A failed preflight can be retried. If dispatch may have happened,
retry checks the actual inbox/history and never blindly resends an answer.

`maxRunning` defaults to 2 (configurable 1–8) per plugin host/team. Admission is
serialized. `idleStopMs` defaults to 900000 (15 minutes), can be 0 to disable, or
at least 60000. The 30-second sweep excludes active operations, held turn leases
and human-controlled desktops. Viewing counts as activity. Idle stop keeps files;
starting again is explicit. These are not machine-wide Docker or disk quotas.

The **Desktop resources** panel persists these limits with revision checks,
rejects a running limit below the active count, and offers free-space/home-size
warnings. Disk sampling is at most once per minute and does not count as activity;
readings older than two minutes or failed scans are marked stale.

Only rootful Podman on XFS project-quota storage can enable a hard quota for new
homes. A temporary labelled probe must demonstrate kernel EDQUOT enforcement
before the default is saved. Existing homes are never resized; restore/upgrade
preserve their quota. Docker ordinary named volumes expose warning thresholds
only. Backup copies and engine root layers are outside the per-home quota; this
is not a whole-engine disk limit. Actual Podman/XFS acceptance is still pending.


Stop the desktop before **Save checkpoint**, **Restore checkpoint** or
**Recreate container**. Checkpoints are local named volumes containing a copied
file tree and SHA-256 manifest; no tar extraction or host bind mount is used.
The offline non-root helper verifies every regular file and preserves symlinks
without following them. Socket/device/FIFO entries are skipped and counted.
Hard links become independent files; ownership changes, ACLs and extended attributes
are not preserved. This is a single-user home recovery format, not a full filesystem image.
Checkpoints default to 20 GiB of regular files; **Desktop resources** can set a
1–1024 GiB limit. The limit is independent of the 200 MiB per-file upload limit.
Each copy supports up to 100000 entries and a 64 MiB manifest. Copying and hashing
use 1 MiB chunks, with a 30-minute deadline per helper. The panel shows background
progress and cancellation; closing it does not stop the task. Cancellation may
require **Finish recovery** to discard staging storage. Two
checkpoints and two previous restored homes are retained per desktop. At those
limits, operations refuse rather than delete data automatically. The recovery panel
provides explicit deletion of saved copies. Full disk quotas and discovery of
legacy orphan volumes without a recovery intent remain unimplemented.

Restore checks Computer/Bot/image identity and the manifest/content hashes, builds
a fresh volume, verifies it, removes only the stopped container, then atomically
publishes the new home revision. The previous home survives. Failed copying or a
failed registry commit cannot overwrite that home; an interrupted publication may
leave a staging volume recorded by its durable recovery intent; restart or
**Finish recovery** cleans it before use can continue. Recreate first saves a checkpoint, then
removes only the stopped container, retaining the current home. Both operations
invalidate old input/control generations and leave the desktop stopped. Start it
explicitly. Checkpoints stay on the same Docker daemon and are not disaster backups
and are not portable across unrelated images. Keep backups as private as the desktop itself.

## Desktop image updates

Open **Desktop image updates** and choose **Check for image updates**. The host
checks up to 20 recent releases in the repository pinned by the shipped archive.
Only a compatible release with an immutable evidence commit (parented by its
source commit, changing only the runtime lock) is offered. Requests use public
GitHub APIs without credentials. Download failures can fall back to the official
release asset API; both routes enforce the pinned manifest and archive hashes.

**Download and verify image** runs in the background and supports cancellation.
It checks the archive and local image platform, driver, protocol and user before
saving the immutable pin. Downloading does not stop, upgrade or change the default
image of any existing desktop. Check again after a host restart if a download was
interrupted; storage mutations and downloads are not automatically replayed.

After verification, stop the intended desktop, select the image in **Desktop
recovery**, choose **Upgrade desktop**, then **Confirm upgrade**. The confirmation
is tied to that desktop generation and exact image. Upgrade saves a checkpoint,
checks a fresh candidate desktop, copies and verifies the home, and tests the
migrated candidate before publication. The previous home and image remain paired
for rollback. Start explicitly after upgrading or switching back.

The managed configuration retains the original image plus up to four prepared
images across Broker/host restarts. Image pruning is manual; never remove an image
referenced by a current or retained home. Explicit runtime profiles still manage
their configured image list themselves; automatic downloads are available for
plugin-managed setup.

## Boundaries and persistence

- `assisted` means Computer is an additional tool. Existing host shell, file,
  browser and capability tools retain their current permissions. This is **not
  `computer-only` isolation of the Bot**.
- Each Computer uses one dedicated Docker volume at `/home/cua`. Host folders,
  `DSH_HOME`, model credentials and the Docker socket are not mounted in it.
- Containers run as UID/GID 1000, on the engine bridge network, without added capabilities, with
  `no-new-privileges`, 2 CPUs, 4 GiB RAM and total memory/swap allowance, and
  a 512 PID limit. No host ports are published.
- A container shares the host kernel. The host-side Broker needs Docker
  authority; it is not a sandbox against malicious processes running as the
  host user. The inherited environment is limited to runtime discovery fields.
- Model screenshots are stored by DSH as image attachments and can remain in
  conversation history. Text typed through a tool is visible in its arguments
  and approval UI. No secret-redaction guarantee is made for pixels or tool
  history. The separate operation journal stores IDs, hashes and receipts,
  without the screenshot or entered text.
- Own-chat and group Sessions share their Bot's desktop but cannot interleave
  its execution lease. Other Bots have different identities and volumes.
  Subagents and archived Sessions do not receive execution authority.
- Broker disconnection invalidates pending requests and prevents automatic
  reconnection. Restart the host to reconcile and revoke old authority. Pending
  journal entries become `unknown`; inputs are never replayed.
- Normal provider disposal revokes and stops managed containers. An abrupt
  host/Broker kill may leave a container running; restart reconciles authority
  but is not a power-failure cleanup guarantee.

Registry and receipts live under `<configured bot home>/computers/registry.json`
and use atomic writes under the existing team home lock. This file is not a
backup of `/home/cua`. Stop/start, same-image container recreation and local
checkpoint/restore, retained-home rollback and journaled storage recovery are
supported. Image upgrades preserve the prior image/home pair for rollback;
whole-engine disk quotas and legacy orphan discovery are still pending.
Do not delete a retained volume without first backing up its data.

## Verification

From `ds-bot/`:

```sh
npm run harness
node --import ./test/harness-resolve.mjs --test test/computer*.test.js
node --import ./test/harness-resolve.mjs dev/computer-smoke.mjs \
  sha256:REPLACE_WITH_THE_64_HEX_LOCAL_IMAGE_ID
npm test
node scripts/build-client.mjs --check
npm run lint
```

Standalone guest check, from the repository root:

```sh
python3 computer-runtime/test/guest-smoke.py --image ds-bot-cua-probe:0.37.0
```

The composed Computer smoke uses public DSH tool/attachment services, a temporary
`.dsh-test-computer-*` directory, a random Computer identity, an offline browser
fixture and independent HTTP markers. It checks screenshot dimensions, click,
text/key/scroll effects, takeover, real chat attachment transfer, persistent home
contents, checkpoint restore and container recreation. It removes only its own
container, labelled volumes and temporary directory in `finally`.

`computer-loop.test.js` separately runs a real DSH AgentLoop with a no-key mock
adapter: the next model request contains the screenshot, file references survive
the tool pipeline, and answering desktop help starts a new turn. These scripted
checks do not establish real visual-model reasoning or a packaged release. The existing `dev/smoke.mjs` remains the separate whole-team
Web regression check.

Recorded results, including the unresolved baseline Web smoke failure, are in
[VALIDATION.md](VALIDATION.md).

See `licenses/cua-MIT.txt` and the repository `NOTICE` for attribution. This
development image is not a distributable release; a complete image SBOM and
release license inventory remain part of P5.

## Windows desktop test entry

Prerequisites: Windows Node.js 22+ and npm, WSL2, a distribution with Node.js 22+
and a local Docker Unix socket, and the image built above in that distribution.
From PowerShell in this checkout:

```powershell
.\start-cua.ps1 -Distribution Ubuntu-24.04 `
  -LinuxNode /home/timdong/.nvm/versions/node/v22.23.2/bin/node
```

Substitute your distribution and Linux Node path. The default image tag is resolved
to an immutable local image ID; the script does not pull/build an image. It uses
`.dsh-test-cua-desktop/` for application data, workspace, window state and Computer
configuration. This keeps evaluation separate from an existing team. It calls the
existing source launcher, which installs dependencies and builds the plugin.
Always launch with `start-cua.ps1` to enable Computers for that run.

For another source launch, set `DS_BOT_COMPUTER_CONFIG` to a JSON file:

```json
{
  "enabled": true,
  "broker": {
    "entrypoint": "/mnt/d/your-checkout/computer-runtime/broker/main.mjs",
    "image": "sha256:REPLACE_WITH_THE_64_HEX_LOCAL_IMAGE_ID",
    "wsl": { "distribution": "Ubuntu-24.04", "node": "/absolute/linux/node" }
  }
}
```

The app reads this explicit operator opt-in through a public DSH patch and preserves
other Bot configuration. Broker paths and runtime configuration are never supplied
by a model or the desktop input API. No persistent DSH profile patch is edited.

The earlier isolated Windows launch reached the native app and loaded the Computer
flag, but the DSH first-run “预览版说明” confirmation could not save. The same
failure occurred with Computer disabled; its cause remains unresolved. See
[VALIDATION.md](VALIDATION.md). Windows GUI acceptance is assigned to the user.

### Manual acceptance checklist

1. Open a Bot's details → **Private desktop** tab (also available in Bot settings).
2. Select **Observe only** or **Observe and operate**, then **Start desktop**.
   With operation enabled, **CUA approval mode** defaults to **Ask before each
   action**. Select **YOLO — no approval** to run CUA actions without confirmation.
   Switch back at any time; each switch invalidates pending actions and old frames.
3. Verify the real XFCE desktop appears. The image refreshes about every 1.5 seconds;
   this is a snapshot viewer, not a video stream. Drag the panel wider if needed.
   While a model action waits for approval, the read-only preview uses a separate
   CUA session and remains visible. A genuine transient busy response keeps the
   last image instead of clearing it, labels it as waiting and disables input
   until a fresh preview arrives.
4. Select **Take control**. Use the live desktop for click, drag, keyboard chords
   and scrolling, or switch explicitly to snapshot controls. Losing focus pauses
   live input. Resume manually; inspect the screen before repeating unknown input.
5. Import a small text file and open `/home/cua/DSBot` inside the desktop. **List files**
   and **Download** should return the exact bytes. Existing names are refused. The
   manual download stays in the browser. Ask the Bot to use `computer_import` on
   a chat attachment and `computer_export` to return the resulting desktop file;
   the returned file should appear as a downloadable chat attachment.
6. **Give back to Bot** releases control. With a vision-capable model configured in
   this test profile, ask it to use `computer_observe` and then `computer_act`; each
   action needs approval in the default mode, while YOLO skips it. Other Bot
   tools retain their original host permissions.
7. Take control in a second window. The first window must lose input/release rights.
   Close the panel: the Bot must stay paused. Reopen and take control explicitly.
8. Stop/start and toggle **Off — keep files**: the Computer identity and files remain.
   Restarting the app stops previously running guests for ownership reconciliation;
   a previous human pause remains. Use **Stop desktop**, **Start desktop**, then
   **Take control** to recover explicitly.

9. Ask the Bot to request desktop help. Open the card, take control, and answer
   **I'm done** or **Skip**. Repeat in a group: only the requesting Bot's group
   work should resume. Send a new ordinary chat message to cancel an old card.
10. Stop the desktop, save a checkpoint, start it and change a small file, then
    stop and restore. Starting again should recover the earlier bytes. Recreate
    should save another checkpoint and preserve the current files.
11. While stopped, use **Switch to this home** to recover the modified pre-restore
    file. Delete an unused checkpoint/previous home with confirmation, then save a
    new checkpoint. Clear operation history; files and chat history should remain.

Guests can reach the internet; egress is not filtered. computer-only isolation,
platform-specific IME behavior and unrestricted host control are not acceptance targets
for this checkpoint. Missing these is expected; stale input, lost files, wrong Bot
ownership or a frozen preview accepting input are defects.

Native Windows bridge smoke (run with Windows Node, using your test config):

```powershell
node computer-runtime/test/bridge-smoke.mjs .dsh-test-cua-desktop/computer.json
```

It creates and cleans its own temporary registry, container and volume. The Python
transfer boundary tests run on Linux with
`python3 computer-runtime/test/files_test.py`.

## Runtime preparation and standalone payload

Run these commands with Node.js 22 or newer in Linux x64 (Windows: use the
configured WSL distribution). `check` only inspects the local Docker Engine and
optional immutable image; it never pulls images or starts/stops desktops.
`start-cua.ps1` also runs this preflight before launching the Windows app.

```sh
node computer-runtime/runtime.mjs check
node computer-runtime/runtime.mjs check sha256:REPLACE_WITH_LOCAL_IMAGE_ID
node computer-runtime/runtime.mjs build
node computer-runtime/runtime.mjs bundle /absolute/new-directory
node computer-runtime/runtime.mjs verify /absolute/new-directory
```

`build` explicitly downloads/builds the locked recipe, streams Docker progress,
and reports the resulting immutable image ID after checking it. Its tag is
`ds-bot-cua:0.37.0`; when using the Windows launcher, pass
`-Image ds-bot-cua:0.37.0` (the older launcher default is the probe tag).
The lock is checked against the Dockerfile and hashed driver requirement before
building or bundling. Build failure does not change any Computer binding.

`bundle` requires a new directory. It copies only the Broker, helpers, recipe,
lock, CLI, notices and documentation and writes SHA-256 hashes to `manifest.json`.
Run `verify` before deploying it, then configure the absolute
`broker/main.mjs` path in that directory. The payload needs no npm installation;
it still requires Linux Node, Docker and the separately built image. The manifest
detects changed files; it is neither a signature nor a complete guest OS SBOM.
Electron builds include this payload as `resources/computer-runtime`; see the
app README for `broker.bundled` configuration. Signed installer acceptance,
prebuilt image publication and automatic image upgrades remain pending.

### Prebuilt image release candidates

First-time plugin setup can pull an optional digest-pinned `publishedImage` from
the shipped lock. The current source lock has no published image and still builds
locally. A promoted release also records `publishedImageId` and
`publishedImageRecipe`: setup refuses a downloaded ID that differs from the tested
image, and lock validation rejects stale recipe evidence. Existing desktops retain
their original image; plugin installation does not migrate their homes.

The image workflow now requires an independent anonymous pull on a fresh runner
before issuing a promotable candidate. Evidence binds the source commit, recipe,
registry digest, smoke results and package inventory. The repository's
`ds-bot/scripts/computer-image-release.mjs` supports read-only `verify` and explicit
`promote`; promotion changes only the source lock. See
`docs/dev/cua-image-release.md` in the source repository for the release procedure.
Evidence checksums are not signatures; use artifacts from a trusted workflow run.
Actual publication and first-download acceptance remain separate release steps.

## Storage recovery and cleanup

Stop the desktop before saving/restoring checkpoints, switching homes, deleting
saved copies or clearing operation history. Deletion uses an inline confirmation;
a changed desktop generation invalidates that confirmation. The current home is
never a deletion target. The two-checkpoint/two-old-home limits are released only
by explicit deletion; normal cleanup does not select old files on the user's behalf.

Each allocating or deleting operation first persists an intent in the registry.
On restart, the Broker revokes the previous authority and reconciles that intent:
unpublished backups/restored homes are removed; explicitly requested deletions
are completed idempotently. A failed cleanup remains visible as **Finish recovery**
and blocks start/rebinding. A committed home stays authoritative. Volumes still
referenced by any container, with foreign ownership or unknown staging provenance
are refused. Legacy orphan volumes without a durable intent are not guessed at.

**Switch to this home** exchanges the active and retained home and increments the
generation. **Clear operation history** removes only this Computer's action and
help receipts, after invalidating old observations/call identities; it does not
remove conversation messages or files. Restore checks the checkpoint image; switching a retained home also selects its paired image. See [the tool policy audit](TOOL_POLICY.md) for why the
current policy remains assisted.

For the generic mock Web bench without a Harness checkout, set `DSH_CLI` to the
absolute installed public `dsh` executable. Slow WSL-mounted checkouts can set
`DSH_START_TIMEOUT_SEC=300`. This mode omits the checkout-only browser picker test
overlay, so it is not identical to the upstream checkout bench.

## Image ownership and application updates

Every new Computer assignment records its immutable `runtimeImage`. New home
and checkpoint volumes also carry `org.ds-bot.computer.image`. Changing the
app's image setting does not migrate a populated home: both the Host and Broker
refuse a mismatched image, including after the original container was removed.
Restore the original configuration to continue using that desktop.

Legacy metadata is pinned only when the original image can be established from
a compatible container or a labelled home. An unlabelled home whose original
container is gone requires operator investigation; the runtime does not guess.
An empty assignment with no home, retained homes, checkpoints or pending storage
operation can adopt a corrected image setting; this invalidates its generation.

App updates can replace the bundled Broker files after shutdown; the configured
image ID and desktop data are retained. If a later app cannot support that image,
it must refuse startup until an explicit migration is available. Explicit migration is available between configured images. Automatic browser-profile downgrade is never used.

## Explicit image upgrades

Keep `broker.image` as the original default and add up to four immutable local
image IDs in `broker.images`, ordered from older to newer. This is an operator
supplied compatibility order, not a browser version detector. New images must
still pass the platform, non-root user, protocol and driver checks; build and
validate them before adding them. Keep both images installed and configured until
all their retained homes, checkpoints and pending recovery operations are retired.
Changing the default alone never migrates an existing home.

On the Windows source launcher, use `-UpgradeImages` with already installed tags
or IDs, in the same order. The launcher resolves and checks them before writing
its isolated configuration. For example, append
`-UpgradeImages 'your-prepared-new-desktop:version'` to your existing launch command.
This does not build or download an image.

In the Computer panel, stop the desktop, select **Desktop image**, then select
**Upgrade desktop**. The runtime:

1. Revokes input and saves a verified checkpoint of the stopped home.
2. Checks a blank candidate with real driver and screenshot calls.
3. Restores the checkpoint to a new home, checking free space in the actual
   Docker volume filesystem before copying.
4. Checks the copied home in the candidate, stops it and publishes image/home
   together with a new generation. Start explicitly when ready.
5. Retains the original home with its original image. **Switch to this home**
   rolls both back, so the old browser never reads the upgraded profile.

A failed or interrupted migration retains the source pair and backup. **Finish
recovery** removes only the journaled candidate, including its temporary
container, before enabling use again. Do not remove image configuration during
recovery. The upgrade selector only offers later images in the configured order;
return to older images through a retained home. Old checkpoints can be restored
only while their source image is active.

**Check storage** reports current-home file bytes and the runtime filesystem's
free/total bytes. This is a bounded scan, excludes symlink targets, and may vary
while the desktop runs. It does not measure host Windows drive space, retained
copies, container writable layers or enforce a hard disk quota. Copies require
256 MiB reserve plus twice the payload size; this is an admission check, not a
reservation against concurrent disk users. The 128 MiB/10,000-entry checkpoint
limit and two-copy retention limits still apply.

## Package inventory and repeatable validation

```sh
node computer-runtime/runtime.mjs inventory sha256:REPLACE_WITH_LOCAL_IMAGE_ID > guest-sbom.cdx.json
node ds-bot/dev/computer-upgrade-smoke.mjs sha256:REPLACE_WITH_LOCAL_IMAGE_ID
```

`inventory` runs an offline, read-only, unprivileged helper without home mounts.
It emits a CycloneDX 1.5 inventory of installed dpkg/Python packages and available
license evidence. It does not certify redistribution rights or enumerate every
statically linked library; unidentified licenses still require review. Both the
inventory script and CUA's MIT notice are included in the verified app payload.

The upgrade smoke creates two temporary image variants and its own Computer,
checks incompatible-image refusal, migration, paired rollback and lost-response
recovery, then cleans only its resources. The variants share the same browser
version; passing is transaction evidence, not a browser version compatibility
matrix. It also reports warm startup and 10 screenshot timings. See
[evidence](VALIDATION.md) for the measured scope and remaining release gates.


## Model gestures and chunked files

`computer_act` still consumes one current observation for one action. Examples:

```json
{"type":"click","x":100,"y":120,"count":2}
{"type":"key","key":"a","modifiers":["Control"]}
{"type":"drag","x":100,"y":120,"toX":400,"toY":300,"durationMs":500}
```

Modifiers are Control, Shift, Alt and Super without duplicates. Keys include the
existing navigation keys, ASCII letters/digits and F1–F12. Drag endpoints must be
inside the observed screenshot; duration is 100–2000 ms. The pinned driver exposes
capture binding for clicks; drag and key calls retain Host/Broker observation and
lease checks. Unknown receipts still require observation, never automatic replay.

Manual and model file transfers support up to 200 MiB. The panel reports confirmed
bytes, supports cancellation and verifies SHA-256 before reporting completion.
Browser checksums are incremental; uploads are read one chunk at a time.
One transfer per desktop is allowed, with a two-minute idle expiry. Imports use
hidden staging files and atomic publication without overwrite; exports read a
fixed snapshot. Each IPC message carries at most 256 KiB of file data. Cancel,
expiry and control revocation clean staging; after a Broker crash, staging files
older than ten minutes are removed on the next transfer. No automatic transfer
resume is attempted. A lost final reply can mean publication already happened;
check the destination before starting again. Legacy single-message read/write
remains limited to 256 KiB. Temporary free-space checks are not hard disk quotas.

After taking control, choose **List files**, then **Delete file** and confirm the
name to permanently remove an unwanted transfer file. Cancelling leaves it intact.
The list shows the total size of listed regular files and runtime disk space;
it excludes hidden staging files and other home directories. Files above the
transfer limit can still be deleted. Active transfers must finish or be cancelled
first. Model file tools do not expose deletion.

Confirmation is tied to the desktop generation and current control ticket. A
metadata version check refuses files changed or replaced since listing. Deletion
targets the selected flat name, with no directory traversal or following links;
the version check is not an atomic inode compare-and-delete against a guest
concurrently renaming files. If a reply is lost, refresh the list before deciding
what to do; the panel does not automatically repeat deletion.

## Recovering the desktop service

For a native Broker connection, open **Private desktop → Recover desktop
service** and confirm the effect on all Bot desktops. Recovery runs in the
background: it cancels active CUA work, invalidates control tickets and viewers,
waits for the old Broker to exit, verifies the original engine connection, then
checks and stops each managed desktop. Saved homes, checkpoints and operation
receipts are retained. Start the desktops you need afterward; input and chat
continuations are never replayed automatically.

Closing the panel does not cancel or repeat recovery. A failed recovery keeps
desktop operations blocked and can be retried after resolving the reported
problem. A changed Docker connection must be restored before retrying.

The legacy Windows-to-WSL stdio bridge still requires a DSH restart, because
exiting its Windows launcher does not prove the Linux Broker has exited. A
Broker crash during an unconfirmed startup or storage operation also requires
restarting DSH and checking lifecycle recovery; the panel does not assume
orphaned engine helpers have stopped. Recovery does not reinstall or restart
the system container engine.
