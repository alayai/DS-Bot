# BotHub

Group rooms are furnished offices with wooden desks, computers, keyboards,
office chairs, bookshelves, whiteboards and plants. The common area has a coffee
bar with a microwave, a snooker table, a lounge and a fitness corner with a
treadmill, dumbbells and a mat. Shared workstations occupy a separate front area.
Select a desk or a teammate to inspect their work; idle characters can use the amenities.
All models and surface textures are generated locally, with no asset downloads.

Workstation monitors show a Bot's running private desktop through read-only
snapshots. Update **both DS Bot and BotHub** for this feature: DS Bot must expose
`passivePreview` so background screens do not postpone automatic idle shutdown.
Up to four visible Bots refresh about once per second, with two captures at a
time; the same Bot shares its picture across group rooms. No desktop is started
or controlled by opening BotHub. Ordinary Agents keep the standby screen.

In browsers with Web Locks, windows in the same storage partition take turns
capturing the same Bot, normally sharing one capture per second. Each window
receives its own authenticated picture; images are not broadcast or persisted.
More windows mean slower refreshes per window. Closing or hiding a preview
cancels its wait. Without lock support, the existing per-view limits still apply.

Stopped or unconfigured desktops show an original standby animation. Normal
plays it briefly when entering 3D; Lively loops it, and Quiet/system reduced
motion keeps it still. A busy desktop briefly retains a marked last image, then
clears it after five seconds without a fresh frame. Hidden pages, disconnection,
room changes and leaving 3D cancel previews and release unused pictures.
Screens keep the original aspect ratio. The preview uses full PNG captures
downsized locally to a 512 × 276 texture; it is not a video stream or a remote
input surface.

Click a Bot's monitor, or select **View desktop** in its details in either 2D or
3D, to open a larger read-only preview. **Fit** preserves the aspect ratio;
**Actual size** shows the original pixels with scrolling. While this window is
open, only its Bot is captured. Escape closes it and restores focus without
changing the scene view. Disconnection, hidden pages and permission changes
clear the picture; switching workspaces or deleting the Bot closes the viewer.
This window still uses periodic snapshots. Smoother streaming and real-container
end-to-end validation remain pending.

The scene follows the host's light/dark theme. Choose **Eco**, **Balanced**
(default), or **Detailed** in the scene's Quality selector. Eco disables shadows;
the other levels use bounded shadow resolution and pixel ratio. This browser
remembers your choice; changing quality preserves your view and selection.
Crowded labels yield to rooms, selected members and active work. Tab reveals
hidden labels for keyboard navigation; 2D always offers the full list.
Use **Motion → Lively** for typing, sweat and wiping the forehead while working;
idle characters can stand, get water, drink coffee, stretch, lift dumbbells,
nap with floating Zzz, or practise snooker. Group offices have a water dispenser;
coffee and snooker stay in the common area. Characters follow aisles and take
turns at shared facilities. New work interrupts an outing and sends the character
back to its desk; selection, labels and close-up cameras follow the same member.
Walking pairs each free arm with the opposite leg. Characters carry a cup to
the water dispenser or coffee machine and back, keeping the cup upright while
walking. Pouring happens only at the dispenser or machine.

**Normal** (default) shows up to five seconds of typing after a work-state change.
**Quiet**, system reduced motion and a lost live connection stop character actions.
Hidden pages pause animation. Motion preferences are local to this browser.
Idle actions are decorative: status labels remain authoritative, napping does
not pause the Bot, and these actions do not call a model. Zzz is visual only;
snooker is an animation, not a playable game. Unknown activity is never treated
as idle. Character motion alone only requires a BotHub update on an already
compatible bridge; private desktop previews require the companion DS Bot update.

The 3D view now gives each group its own room. A Bot that belongs to several groups
has a seat in each room; team totals still count that Bot once. Each seat shows
only that group's activity. Direct chats and ordinary Agents live in the common
area, and subagents follow their actual root conversation. Select a room label
to enter it, then select a member to open the corresponding group chat.

Selecting a 3D seat enters its room and brings the member into close view.
Use the location trail or Escape to return from member to room to overview.
Tab to the scene for keyboard controls: arrow keys rotate, +/− zoom, and Home
resets the current view. Search fields and selectors keep their normal keys.
Live updates preserve your camera angle and zoom. Switching to 2D preserves
a room selection; an aggregate 2D selection is cleared when returning to 3D.

The overview renders up to 24 rooms and 50 seats. Select a group to see a room
omitted from the overview, or use 2D to see all matching members. Empty groups
remain visible. Group navigation before the first observed run requires the
companion DS Bot workspace build with `groupNavigation` support.

English | [中文](README.zh.md)

An independent DSH plugin that shows your DS Bot team in 2D and an original
interactive 3D workspace. Select a teammate, inspect each active conversation,
send a quick message, or open the original chat for full replies and controls.

## Live updates and recovery

BotHub allows one authenticated event stream per monitoring path in a browser
storage partition. Other windows use authenticated snapshot polling, leaving
connections available for desktop previews and actions. The stream receives a full
baseline followed by changes to members, conversations, runs and groups.
After a disconnect it resumes from the last applied version, or loads a new
baseline if the host restarted or the replay window expired.

While disconnected, the last known scene stays visible and actions are disabled.
Hidden pages close their stream and reconnect when visible. If streaming is
unavailable or used by another window, a notice identifies periodic snapshot
polling; BotHub automatically checks whether a stream can be opened. Browsers
without Web Locks also use polling. Authentication failures clear the view;
sign in again and use **Refresh**, or let DSH's newly authenticated connection
trigger a fresh baseline.

The stream describes observed current state and bounded recent endings, not a
complete run history. The companion bridge retains up to 16 endings per observed
conversation, including turns that finish between samples. Details show the latest
16 endings across the selected conversations (expand **Recent finished runs**): completed, stopped, failed, or
outcome unavailable. Missing or nonresident sessions have no inferred outcome.
Removed members and rotated conversations drop out of this view. An older bridge
can still miss very short activity between samples. No message bodies or tool output
are included. Existing compatible DS Bot installations only need a BotHub update.

## Run conversations

Each active run has a **View run conversation** button. It opens that run's own
conversation, including when a Bot works in private and in several groups at once.
For group Bots, open the group details and find the member to stop its group work.
For other local runs, check the current work in the native conversation before
using its stop control. Navigation itself does not stop work.

The pinned DSH API cannot atomically restrict cancellation to a selected run.
BotHub therefore keeps stopping in the native view. Disconnected run links are
disabled; read-only hosts allow viewing, with controls left to the owning host.
This addition only requires updating BotHub on an existing compatible installation.

## Quick messages

With the companion DS Bot build exposing `messaging: 1`, Bot details include a
plain-text composer (up to 4000 characters). Common-area and aggregate 2D
selections send to that Bot's current private chat. Inside a group room, the
message goes to the **group chat**, using its normal routing and @ mentions.
The composer names its destination. Ordinary Agents and subagents still use
the original conversation.

**Accepted** confirms admission, not completion of the Bot's task. A timeout
shows **Delivery is unconfirmed**; use **Check receipt** or the original
conversation. Checking never resends the message. **New message** clears the
draft and receipt display; it does not cancel the previous delivery.

Drafts stay in plugin memory while switching members or rooms. Reloading keeps
only command addresses in session storage so receipts can be checked again;
it does not preserve message text. Read-only hosts cannot send. An older bridge
continues to monitor and navigate, with quick messages disabled.

The companion bridge persists command identifiers, scope, destination, payload
hash and acceptance state before dispatch. It stores no message body in its
receipt ledger. The preview keeps up to 2048 receipts and refuses new quick
messages at the limit; the native conversation remains available. Do not delete
the ledger to retry an uncertain request. Receipt recovery checks a bounded
window of host evidence; missing evidence stays unconfirmed.

## MVP scope

- Team search, group and state filters, active run and attention counts.
- Concurrent own-chat and group runs stay separate under one Bot identity.
- 3D selection, camera orbit and zoom, with equivalent 2D navigation.
- Passive monitoring; opening BotHub does not create a Bot or start a model.
- Unknown activity is labelled **Not observed**, never assumed idle.
- Connection failures preserve the last snapshot and disable conversation
  actions; authentication failures clear the snapshot.
- Only identifiers, names, roles, tool names and state categories enter the
  monitor. No chat text, instructions, file paths, tool arguments or secrets.

Registered DSH Agents and local subagents show their resident Agent's real
running/idle state. Nonresident sessions remain **Not observed**. Parent/child
relationships come from DSH's explicit catalogs; select either side in the detail
panel and open the native child conversation. External children cannot open locally.
Discovery is bounded to 64 catalog reads, 64 children, four levels and two seconds
per snapshot; a banner identifies partial coverage. It never loads an Agent.

Active tools, turn start times, live approvals and user questions are now tracked
through public DSH events and projections. Concurrent tools settle independently.
A timed question can remain unanswered while the Agent continues working; the
member needs attention without falsely showing its run as paused. Question and
approval text stays in the native conversation.

Details degrade explicitly when projections are unavailable. A legacy question
already waiting before the monitor loads cannot be reconstructed as a live wait;
its active tool remains visible. Nonresident sessions and complete historical outcomes,
scene editing and direct stop/approval controls remain outside this slice.

## Requirements and installation

This preview targets the repository's DSH `0.2.1-rc.4` baseline and the **DS Bot
checkout containing `src/host/monitor.js`**. An older published DS Bot will show
the bridge-unavailable message. Quick messages also require the companion
`src/host/monitor-commands.js` implementation; update **both plugins** for this
slice. It does not patch DSH.

1. Build this directory with Node.js 22.19+:

   ```sh
   npm ci
   npm run build
   npm test
   npm run lint
   npm run check
   ```

2. In the DSH plugin manager, install this local package directory as a bundle
   alongside the compatible DS Bot bundle, and enable BotHub.
3. Open **BotHub** using the cube button beside the account button in the DS Bot
   sidebar. The ordinary DSH sidebar also has a BotHub panel entry.
   Choose **2D** if your device cannot create a WebGL renderer.
4. Click a Bot and use **Quick message**, or choose **Open conversation**.
   Group work opens the group chat, where DS Bot owns approvals and member controls.

This is the signed-in user's view of the current DS Bot team in that host.
It is not a multi-tenant monitoring API, an agent-callable tool or an external
CLI collector. It uses DSH's authenticated connection service and same-origin
requests. No new server or port is required.

Disabling BotHub removes its channel, UI and renderer. It does not stop the team.
Monitoring uses an event stream with 5-second reconciliation, or 2.5-second
fallback polling while the panel is visible. Hidden pages do
not draw or start additional polls. 3D displays up to 50 contextual seats; 2D
lists all of them. No external assets or CDN requests are used.

## Isolated development bench

Use native Node and pnpm for your OS; do not mix Windows package links with a
Linux DSH process. The helper uses the public installed `dsh` CLI and the
repository's scripted mock model:

```sh
# From the repository root; choose unused ports.
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 \
  sh dsh-bothub/dev/bench.sh bothub-smoke 3196 8896 start

# Existing host regression smoke:
node ds-bot/dev/smoke.mjs bothub-smoke 3196

# Always stop processes started by the bench.
sh dsh-bothub/dev/bench.sh bothub-smoke 3196 8896 stop
```

The bench writes only to `.dsh-test-bothub-smoke/`. `DSH_CLI` may name another
installed public CLI. It never uses the user's actual DSH profile.

On WSL, the bench data must support owner-only file permissions. If your Windows
mount reports every file as mode `777`, create a fresh directory on the Linux
filesystem and symlink `.dsh-test-bothub-smoke` to it **before its first start**.
Do not relax DSH's credential permission checks.

In this mock bench, add a **DSH Agent** from the team menu and send
`BotHub work 10` in its native conversation. Open BotHub to see running → idle.
Then send `BotHub delegate 20`: DSH starts a real local subagent named
**BotHub review task**. Select it in BotHub, follow its parent relationship,
and open its native conversation. These scripted commands are test fixtures,
not commands added to production models.

For alpha.3, send `BotHub tool 10` to inspect a real harmless shell tool, send
`阻塞提问` to answer the native question and verify the attention clears, then send
`BotHub approve` and reject its native permission request. Verify each state in
BotHub before returning to the original conversation.

## Development contract

For a synthetic 20/50-member renderer benchmark, run
`node scripts/build-scene-benchmark.mjs` in this directory. Serve the generated
`../.playwright-mcp/bothub-scene-benchmark/` directory on a local test port.
At a 1920px viewport and device pixel ratio 1, run
`await runBenchmark({ count: 20 })` and then `await runBenchmark({ count: 50 })`
in the browser console. The workload uses the actual renderer, original models
and label layout, without a host or model. It reports CPU callback time, frame
intervals, WebGL draw calls and resource cycles; CPU time is not GPU completion
time. This is separate from the real-host integration and recording bench.

- `client.js` is generated from `src/client/`; never edit it directly.
- The host consumes the version-2 `botMonitor` service owned by DS Bot.
- DS Bot declares the additive `bot.sidebar.action` list slot in its own
  sidebar footer; companion plugins can register there through `slots.inject`.
- GET `api/bothub` returns the minimum current snapshot. POST accepts
  `{ action: "resolve", entityId, sessionId?, groupId? }` for navigation,
  `{ action: "send", commandId, workspaceId, entityId, groupId, text }` for an
  explicit message, and `{ action: "receipt", commandId }` to check admission.
  Commands require JSON and the host-authenticated user; groupId is null for private chat.
- GET `api/bothub/events` streams versioned snapshots/patches. `Last-Event-ID`
  resumes a bounded suffix; it cannot choose a workspace. The shared replay
  buffer keeps at most 128 patches / 1 MiB. Each reader has a 1 MiB queue and
  a 60-second connection lease, after which the carrier rechecks authentication.
  The stream accepts at most 16 simultaneous readers. Host notifications are
  coalesced for 150 ms, with a 5-second reconciliation and 15-second heartbeat.
  Polling fallback checks every 2.5 seconds after success and probes the stream
  after 12 successful polls. Failures use jittered backoff up to 30 seconds.
  Client Web Locks limit each storage partition/path to one reader; other views
  poll immediately without reporting an artificial connection failure.
- Resolution returns `{ target }`: a root session ID or the native
  `{ parentSessionId, childSessionId, mode }` address, validated by the host.
- Group-member sessions resolve to the group chat. A Bot's default target is
  resolved to its current segment at click time.
- The renderer draws on state, size or camera changes and while enabled character
  actions need frames, capped at 12/24/30 fps by quality level. All geometry,
  materials, listeners and the WebGL context are released on unmount.

See the [MVP design](../docs/plans/2026-11-07-dsh-bothub-mvp.md) and
[development plan](../docs/plans/2026-11-07-dsh-bothub-development-plan.md).

See the [Agent slice design](../docs/plans/2026-11-07-dsh-bothub-agents.md) for alpha.2.

See the [activity slice design](../docs/plans/2026-11-07-dsh-bothub-activity.md) for alpha.3.

See the [camera and keyboard slice](../docs/plans/2026-11-08-dsh-bothub-camera.md)
for the subsequent workspace implementation.

See the [furnished office slice](../docs/plans/2026-11-08-dsh-bothub-office.md)
for the office layout, shared geometry, resource checks and local demonstration.

See the [messaging slice](../docs/plans/2026-11-08-dsh-bothub-messaging.md)
for admission, idempotency, recovery and verification.

See the [projection stream slice](../docs/plans/2026-11-08-dsh-bothub-stream.md)
for replay limits, reconnect behavior, verification and current coverage.

## Release candidate installation and rollback

`0.1.0-rc.4` accepts DSH `0.2.1-rc.3` and `0.2.1-rc.4`, with Cordis `4.0.5`. Install the
companion DS Bot archive from the **same candidate directory** first, then the
BotHub archive, through the host plugin manager's local bundle installation.
The DS Bot archive still identifies as `0.2.16`; its version alone cannot prove
bridge compatibility. Verify the candidate's SHA-256 manifest and restart the
host after updating both bundles. Keep exactly one enabled copy of each bundle.
An old published DS Bot is insufficient.

When upgrading from the paired rc.3 candidate, only BotHub needs updating for
the walking and cup fixes; its companion DS Bot archive is unchanged.

For a first check, open BotHub, confirm Connected, select a Bot in 2D, send a
short message, check Accepted, then open its original conversation. Switch to
3D, enter a group room and check its destination before sending. A stopped
desktop should show Standby without starting a container.

Disable BotHub in the plugin manager and restart to remove its panel and monitor
channel; the Bot team continues in DS Bot. To roll back, disable BotHub, reinstall
the previously saved BotHub bundle, then restart. Keep the compatible DS Bot
bridge installed: older BotHub clients ignore the additive recent-run fields.
Do not delete the team, session data or receipt ledger to roll back. Reinstall
the candidate bundle to upgrade again. No data migration is required by BotHub.

Validated baseline and platform results are recorded with the candidate. The
current evidence covers a Linux/WSL DSH Web host and Windows Chrome client;
Electron, Safari, macOS and real-container private desktops require separate
validation. Direct run cancellation, embedded approvals, streaming video, full
history, layout editing and external CLI monitoring are not provided in this MVP.
