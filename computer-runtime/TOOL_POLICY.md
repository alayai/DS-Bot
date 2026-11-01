# Computer tool policy audit — 2026-10-31

Scope: the current DS Bot working tree and the pinned public DSH 0.2.1-rc.4
interfaces. This is an implementation audit, not a certification of third-party
plugins. `executionPolicy` still accepts only `assisted`; `computer-only` is
rejected at binding and registry loading. YOLO changes CUA action approval only.

| Surface | Current behavior | Required before `computer-only` can be enabled |
|---|---|---|
| Eleven `computer_*` tools | Registered in current Bot Agent scope; execution rechecks Bot, Session, turn, grant and generation. Child Agents cannot use the desktop. | Retain these checks, including direct and nested dispatch. |
| Desktop start, stop, bind and storage | Authenticated `api/bot` management endpoints; no corresponding model tools. | Keep runtime paths, image IDs, volume names and permissions operator-owned. |
| Native shell, filesystem, terminal and jobs | Continue under the existing DSH permission preset. The guest's isolation does not isolate these tools. | Deny host effects, background jobs and indirect execution for the restricted Agent. |
| `run_code`, nested tools and wrappers | Public monotonic `tools.guard` covers ordinary and parent-token nested executor calls, as tested in `computer-dsh.test.js`. | Check every delegated effect, not just the outer tool name. A tool body can also call host services directly. |
| Bot browser / browser plugins | Separate host browser capability; Computer grant does not govern it. | Deny host browser access or explicitly provide an isolated guest route. |
| MCP, skills and capability save/attach | Dynamic, per-Agent capability mounting remains active. Skills can instruct later host tools; MCP can cause external effects. | Reject capability mutation and unknown registrations; define a stable audited registration/effect contract. |
| `message_bot`, group posting and Bot/group administration | Existing team collaboration and Main Bot rights remain. A recipient Bot can perform work under its own permissions. | Define transitive delegation policy. Blocking shell locally while allowing an unrestricted recipient is insufficient. |
| `ask_user`, `show_view`, model/team listing | Existing chat UI and metadata behavior remains. These are host effects even when they do not execute shell commands. | Explicitly review allowed disclosures, shared state and UI side effects. |
| Attachment import/export | Current-Session attachment provenance; bounded bytes and flat guest paths; no arbitrary host paths. | Keep transfer boundaries and distinguish intentional file disclosure from unrestricted filesystem access. |
| Hooks, schedules and direct service calls | Trusted host plugin code runs outside the model's tool sandbox. | Limit composed plugins and audit other scheduling/dispatch routes. A tool-name mask alone is insufficient. |

Evidence in this repository:

- `ds-bot/src/host/computer.js`: scoped registration and Computer guard.
- `ds-bot/src/host/computer/service.js`: binding, ownership, generations and assisted-only policy.
- `ds-bot/src/host/tools.js`: collaboration, administration and capability tools.
- `ds-bot/src/host/capabilities.js`: dynamic Agent capability composition.
- `ds-bot/src/host/permissions.js`: existing Session/group permission presets.
- `ds-bot/test/computer-dsh.test.js`: public guard, nested dispatch and child scope tests.
- `ds-bot/test/computer-loop.test.js`: actual mock-driven DSH AgentLoop and image request roundtrip.

The public `ctx.tools.restrict` contract masks inherited global tools; scoped
registrations remain visible. `ctx.tools.guard` is a synchronous monotonic
execution guard. Both are useful, but neither by itself proves that every
allowed trusted tool or hook has only guest effects. No private DSH API or
runtime patch was introduced. A future isolated mode needs a reviewed closed
composition and delegation policy; unsupported isolation must remain unavailable.

The queued-task tool `computer_task_update` only records progress/results for the
current fenced task and turn. Management and backup operations remain user-only.
Queue pause/recovery and guest network policies do not isolate host tools.

The guest Firefox tools use bounded, original protocol commands over the existing
engine connection, with no caller JavaScript, privileged browser context or
published control port. They reuse the same screenshot-context, approval/YOLO,
receipt and lease checks. Element actions validate a fresh DOM snapshot rather
than pixel equality; changed node identity, URL/tab or bounded form state is
refused. Unknown results remain unknown and are not automatically retried.
Password and file inputs are refused. Guest profiles remain private desktop data.

Task timeouts block new Computer calls immediately at the deadline; the periodic
watchdog additionally persists a pause and revokes input before cancelling the
matching turn. Repeating tasks only advance after explicit success. Delivery
uncertainty, failed results and interrupted attempts never cause unattended retry.
These guarantees apply to Computer tools, not to an Agent's other host tools.
