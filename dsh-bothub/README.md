# BotHub

The 3D view now gives each group its own room. A Bot that belongs to several groups
has a seat in each room; team totals still count that Bot once. Each seat shows
only that group's activity. Direct chats and ordinary Agents live in the common
area, and subagents follow their actual root conversation. Select a room label
to enter it, then select a member to open the corresponding group chat.

The overview renders up to 24 rooms and 50 seats. Select a group to see a room
omitted from the overview, or use 2D to see all matching members. Empty groups
remain visible. Group navigation before the first observed run requires the
companion DS Bot workspace build with `groupNavigation` support.

English | [中文](README.zh.md)

An independent DSH plugin that shows your DS Bot team in 2D and an original
interactive 3D workspace. Select a teammate, inspect each active conversation,
and open the original chat to send a message, stop work or answer an approval.

## MVP scope

- Team search, group and state filters, active run and attention counts.
- Concurrent own-chat and group runs stay separate under one Bot identity.
- 3D selection, camera orbit and zoom, with equivalent 2D navigation.
- Read-only monitoring; opening BotHub does not create a Bot or start a model.
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
its active tool remains visible. Nonresident sessions and historical outcomes,
SSE replay, scene editing and direct execution controls remain outside this slice.

## Requirements and installation

This preview targets the repository's DSH `0.2.1-rc.4` baseline and the **DS Bot
checkout containing `src/host/monitor.js`**. An older published DS Bot will show
the bridge-unavailable message. It does not patch DSH.

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
4. Click a member, then **Open conversation**. Group work opens the group chat,
   where DS Bot owns approvals and member controls.

This is the signed-in user's view of the current DS Bot team in that host.
It is not a multi-tenant monitoring API, an agent-callable tool or an external
CLI collector. It uses DSH's authenticated connection service and same-origin
requests. No new server or port is required.

Disabling BotHub removes its channel, UI and renderer. It does not stop the team.
Monitoring polls every 1.5 seconds while the panel is visible. Hidden pages do
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

- `client.js` is generated from `src/client/`; never edit it directly.
- The host consumes the version-2 `botMonitor` service owned by DS Bot.
- DS Bot declares the additive `bot.sidebar.action` list slot in its own
  sidebar footer; companion plugins can register there through `slots.inject`.
- GET `api/bothub` returns the minimum current snapshot. POST accepts only
  `{ action: "resolve", entityId, sessionId? }` to recheck a navigation target.
- Resolution returns `{ target }`: a root session ID or the native
  `{ parentSessionId, childSessionId, mode }` address, validated by the host.
- Group-member sessions resolve to the group chat. A Bot's default target is
  resolved to its current segment at click time.
- The renderer only draws on state, size or camera changes. All geometry,
  materials, listeners and the WebGL context are released on unmount.

See the [MVP design](../docs/plans/2026-11-07-dsh-bothub-mvp.md) and
[development plan](../docs/plans/2026-11-07-dsh-bothub-development-plan.md).

See the [Agent slice design](../docs/plans/2026-11-07-dsh-bothub-agents.md) for alpha.2.

See the [activity slice design](../docs/plans/2026-11-07-dsh-bothub-activity.md) for alpha.3.
