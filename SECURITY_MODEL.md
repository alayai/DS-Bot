# DS Bot security model

The threat model that security reviews and scans of this repository start from. Infrastructure is `docker/` and `docker-compose.yml` in this repository.

## System overview and trust boundaries

DS Bot is a team of long-lived LLM Bots built as a plugin on DeepSeek Harness (DSH). It runs in three ways:

- **DSH Desktop / DSH Web** with the `ds-bot` plugin, on the user's own computer.
- **Desktop app** (`app/`, Electron) that runs a pinned DSH with the plugin in its own `DSH_HOME`, and imports a team from `~/.dsh` (read only).
- **Docker** (`docker/`, `docker-compose.yml`): `dsh web` on `0.0.0.0:3080` (published as `0.0.0.0:13080`), `DSH_PERMISSION_MODE=danger-full-access`, approval `never`. The container is the sandbox boundary.

Trust boundaries:
1. Untrusted content -> model -> Bot tools. Web pages, files, search results, connector/MCP results and messages from other Bots reach the model; the model's tool calls run with the Bot's permission preset.
2. Ordinary Bot -> Main Bot rights (create/change/stop Bots, groups, folders), enforced in `ds-bot/src/host/tools.js` via `rt.isMain`.
3. Model/tool output -> outbound model requests (secret redaction in `ds-bot/src/host/secrets.js`).
4. Browser renderer -> host: `POST /api/bot` channel (`ds-bot/src/host/channel.js`, `ROUTE` in `constants.js`) and Electron IPC (`app/src/main.mjs`, `preload.cjs`).
5. Bot-produced HTML widgets -> app page (`ds-bot/src/client/widget-html.js`, `sandbox="allow-scripts"` iframe without same-origin).
6. Bot browser pages -> app (`app/src/bot-browser.mjs`, `bot-views.mjs`: sandboxed, contextIsolation, own partition).

## Optional Computer development runtime

The opt-in `computer.enabled` backend adds a separate boundary:
DSH scoped tools → Computer ownership/lease/approval service → private IPC
Broker → offline Linux container → Cua Driver. It is separate from the Docker
distribution above. Its Broker requires local Docker authority and an
operator-configured executable and immutable image ID. Models and `/api/bot`
payloads cannot select host mounts, runtime commands or raw driver tools.

The preview supports only **assisted** operation: existing host tools retain
their permissions. It is not a sandbox for the whole Bot or protection against
malicious host processes running as the same OS user. The guest is non-root,
has resource limits, no published ports and no host bind mounts; it shares the
host kernel and has a dedicated persistent home volume.

Every model action requires a current, stored DSH image attachment, the current
Bot Session/turn lease and an operate grant. Approval defaults to one-time
confirmation (`approvalMode: required`). The user can explicitly select
`approvalMode: yolo` for one desktop to skip Computer action approvals. This
setting persists; it does not change host tool permissions or grant access to
other desktops. Changing it revokes old observations and pending authority.
YOLO still checks the current frame before dispatch and never replays unknown
results. Models cannot select the approval mode through a Computer tool. Human takeover
revokes model observation/input before issuing a window-specific, expiring token.
Human input requires that token, the current generation and a fresh displayed
frame; changed frames are refused before dispatch. A closed viewer or expired
token leaves the Bot paused, including across host restarts. Read-only previews
use a separate driver session and never grant input authority.
After transport failure the result can be unknown; automatic replay and Broker
reconnection are disabled. A successful driver response is not proof of the
application-level result.

Screenshots remain in DSH attachment/history storage and typed text can appear
in tool arguments and approval records. Pixel secrets are not text-redacted.
The Computer receipt journal excludes image bytes and entered text. Viewer frames
and human tokens stay in window memory. The Windows bridge uses private WSL pipes,
not a network listener, and forwards no application credentials. Human file
transfer is restricted to a flat `/home/cua/DSBot` directory, 256 KiB per file,
with no-follow directory handles, regular-file checks and no overwrites. Imported
files remain untrusted content. Model export now returns a DSH file attachment;
model import is bound to references in the executing Session context.
Stopping or archiving retains the home. Stopped-home checkpoints, restore and
container recreation and explicit image migration use verified staging volumes.
Journaled staging cleanup is implemented; arbitrary orphan cleanup, current-home
purge and full redistribution review remain unavailable. See
[Computer runtime](computer-runtime/README.md) for the verified boundary and
remaining limitations.

## Components

- **host** — plugin server side: `ds-bot/index.js`, `ds-bot/src/host/` (roster, tools, turns/delivery, groups, parts, memory, schedules, permissions, connectors, providers).
- **secrets** — `ds-bot/src/host/secrets.js` (secrets.json mode 600, `$DSH_SECRET_<NAME>`, redactor) and API keys/providers (`providers.js`, `models.js`).
- **client** — browser UI: `ds-bot/src/client/` (incl. widget-html, read-page, connectors UI) and generated `ds-bot/client.js`.
- **browser** — Bot browser bridge and browser plugins: `ds-bot/src/host/browser.js`, `browser-plugins.js`, `src/host/browser/`, `browser-plugins/`.
- **desktop-app** — Electron app: `app/src/` (main, preload, IPC, cookie import, updates, import from `~/.dsh`, move-data), `app/engine/`.
- **web-search** — `ds-bot/web-search.js`.
- **docker** — `docker/Dockerfile`, `entrypoint.sh`, `docker.patch.yml`, `docker-compose.yml`.

## Entry points and who reaches them

- Chat input from the user (trusted).
- Content the Bot reads: web pages (Bot browser, `read_browser`, web search), files in the work folder, connector/MCP tool results, messages from other Bots and group chats, scheduled-task prompts. **Attacker-controlled.**
- `/api/bot` HTTP endpoints and DSH Web UI: the local user; in Docker, anyone who can reach port 13080 (DSH trusted-host list + launch token).
- Electron IPC from the app window.

## Assets (maintainer-ranked)

1. **Critical: API keys and Bot secrets** — provider keys, `secrets.json`, `$DSH_SECRET_*`, connector tokens. Must not leak to the model, logs, tool results, other Bots outside the secret's scope, or outbound requests.
2. **Critical: files on the user's computer** — outside the Bot's work folder; `~/.dsh` must never be written by the app.
3. Other: imported cookies / browser login state, conversations and memory.

## Attacker profiles

- **Primary (maintainer-confirmed): prompt injection** in web pages, files or messages that makes a Bot exceed its rights — exfiltrate keys/secrets, read or write user files outside its scope, gain Main Bot rights, change other Bots, bypass the permission preset or redaction.
- Lower concern (not chosen by the maintainer): LAN users reaching the Docker web UI, malicious browser plugins or connectors, a rogue ordinary Bot acting by itself.

## Existing controls

- Main-Bot checks in `tools.js` (`rt.isMain`, `rt.isAdminOf`).
- Per-Bot permission presets (`permissions.js`), set on every Session.
- Secrets: scoped per Bot (`canUse`), redacted from tool results and outbound model requests (`redactor`, JSON/URL-encoded forms).
- Connectors refuse non-HTTPS addresses (`connectors.js`).
- HTML widgets in `sandbox="allow-scripts"` iframes; Electron webviews sandboxed with contextIsolation and own partitions; IPC handlers call `assertWindow(event)`.
- Cookie values stay in the Electron main process (`cookie-import.mjs`).
- Launch token redacted from host logs (`host-process.mjs`).

## Out of scope / accepted risk (maintainer)

- **Docker edition: Bots have full access inside the container by design** (`danger-full-access`, approval `never`). A Bot changing or reading files inside the container is not a finding; escaping the container or leaking keys/secrets still is.
- DSH itself is upstream; not explicitly ruled out, but fixes belong upstream (hard rule: never patch DSH).

## Open questions

- Is the Docker web UI expected to be reachable only on a trusted LAN?
- Should a secret scoped to one Bot be treated as hidden from Main Bots too?

## Computer checkpoint and continuation boundary (2026-10-31)

Model file import accepts only a file reference in the executing Session's active
context. The attachment provider supplies the bytes; a model cannot supply a host
path. Import requires operate access and approval unless that Computer is in
YOLO mode. Import outcomes are journaled before dispatch; an uncertain write is
not replayed. Export emits a normal durable DSH attachment. Both are limited to
flat files of 256 KiB and are blocked during human control.

Desktop help notes are intentionally stored (up to 1000 characters); they must
not contain credentials. Done/Skip conveys the user's report, not proof of page
state. Continuations retain Computer/generation/Bot/group identity, validate again
at inbox insertion, and do not replay ambiguous dispatches. General Bot tools keep
their existing assisted-mode permissions.

Checkpoints require a stopped home and a read-only source mount. The helper has
no network or host bind mounts, runs as UID/GID 1000, and only writes a newly
created managed volume. Regular-file hashes and a manifest hash bind restore to
the original Computer/Bot/image. Symlinks are copied without following them;
special files are skipped. Restore verifies the new volume before registry
publication, preserving the old home. Retained copies contain the same sensitive
files as the original and stay on the same Docker daemon. They do not protect
against host-admin tampering or loss of that daemon. Interrupted operations are
reconciled only from a durable intent, after input revocation; unjournaled orphan
volumes are never guessed at or automatically removed.

An image upgrade uses a separately labelled candidate container/home, verifies
blank and restored desktops, then publishes image and home in one registry write.
The previous image/home pair remains available. The operator supplies an ordered
image list; upgrade cannot select an earlier entry. Rollback selects the retained
pair, and cross-image checkpoint restore is refused. Candidate startup shares the
running-desktop limit. A lost reply cannot cause implicit migration publication.

Storage diagnostics run in a bounded, read-only helper on the same Docker daemon,
without host bind mounts or networking. File-byte totals are approximate while a
home is running; the copy headroom check is not a reserved quota and cannot stop
other processes from filling the disk. Hard disk quotas are not claimed.
The guest SBOM enumerates dpkg/Python packages and available notice hashes;
it is neither a complete static-library inventory nor redistribution approval.
