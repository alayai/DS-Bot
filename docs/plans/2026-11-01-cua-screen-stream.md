# CUA screen stream

## Problem and reference implementations

The Computer panel requested a PNG about every 1.5 seconds. Input, management,
visibility changes and errors cleared that image, temporarily removing the
visible surface. Changing an image's source also leaves decoding and painting
between captures. Raising the polling frequency does not fix these lifecycle
problems.

OpenMausBot's `desktop-connection.ts`, `LiveDesktop.tsx`, `DesktopViewer.tsx` and
`server/routes/desktop-viewer.ts` use noVNC's RFB decoder with an authenticated
WebSocket proxy. rakazo's `computer-screen.ts`, `screen-proxy.ts` and
`novnc-html.ts` also retain a noVNC viewer and proxy the RFB connection. Their
shared useful design is incremental framebuffer updates on a persistent display.
No code or assets from those implementations were copied.

## Implemented transport

```text
DSH Web / Windows Desktop ComputerScreen
  -> noVNC public raw-channel adapter
  -> authenticated WebSocket, or DSH connection.fetch POST fallback
  -> Computer service: ownership + generation + lifecycle checks
  -> Broker IPC (or Windows WSL stdio)
  -> docker/podman exec Python relay
  -> container-only 127.0.0.1:5901 TigerVNC
```

The route is `/api/ds-bot/computer-viewer`; the client uses a document-relative
URL so mounted Web deployments continue to work. DSH's public exact Fetch routes
admit owner principals on both Web and shell carriers. There is no required
`webServer` service, additional host listener, published VNC port, or token in a
URL. A random viewer id is returned in the response and sent in subsequent
request bodies. It grants no access without DSH authentication.

When the optional public `webServer.registerUpgrade` API is available, the open
response advertises `/api/ds-bot/computer-viewer/socket`. `connection.admit(req)`
authenticates the upgrade as the current owner. The first WebSocket message
claims the already-opened viewer; only then does binary RFB start. The viewer
id travels in the message, never in the URL. The socket is periodically
reauthenticated and closes immediately when its admitted peer is revoked.

HTTP(S) clients try that socket for up to three seconds. If an upgrade fails,
they retire the old viewer, open a fresh one and use a long-poll downlink plus
a serialized Fetch uplink. Desktop shell clients without an HTTP(S) document
base use Fetch directly. These transports carry RFB bytes, **not screenshots**.
No WebSocket server is required in the Windows shell. Fetch requests wait up to
20 seconds when idle and return immediately when data arrives; the next read
acknowledges the preceding response.

noVNC's live canvas is displayed directly. Its public `getImageData()` is used
only to detect the first painted frame and save a poster before disconnect or
mode changes. There is no periodic framebuffer copy during steady viewing.
The poster remains underneath the live canvas and survives noVNC removing its
canvas on disconnect. No private noVNC fields are accessed.

## Bounds and authorization

- One downstream Broker chunk (at most 64 KiB) is in flight per viewer. Its
  subprocess stdout is paused until acknowledged. The route queue is bounded
  to 128 KiB and the browser uplink to 64 KiB. WebSocket delivery adds an
  ordered, acknowledged receive window of at most 512 KiB. It withholds Broker
  acknowledgement when full, rejects invalid/out-of-order acknowledgements,
  and expires missing acknowledgements after 30 seconds at the next heartbeat.
- Each uplink waits for the subprocess stdin write callback. The Python relay
  has bounded buffers, handles partial writes, and exits on stdin EOF.
- At most four viewers per desktop and sixteen per Broker/route are admitted.
- Server parsing validates fragmented RFB 3.8 / None / shared-client handshake.
  Observation forwards only pixel format, encoding negotiation, framebuffer
  requests, continuous updates and bounded fence messages. Explicitly authorized
  interactive sessions also accept standard key and pointer events. Clipboard,
  resize, power, extended-key and unknown messages close either viewer.
  Control-related capability advertisements are removed. Both Host and Broker
  parse the stream; browser `viewOnly` is additional UI behavior.
- Pending opens are registered before awaiting the provider and revalidated
  afterwards. Stop, rebind, archive and disposal close pending and live viewers.
  Normal model release/end-turn fence revocation does not tear down observation.
- Ownership/generation/recovery is checked on exchanges and periodically.
  Abandoned observation routes expire after 45 seconds. Interactive routes expire
  after six seconds without client activity, checked each second. A separate
  two-second authenticated client heartbeat has a three-second request timeout;
  automatic WebSocket pongs do not extend the interactive deadline. Active
  viewers prevent idle shutdown; closing the panel keeps the Bot paused.

## Display and human control

- Normal observation uses RFB and stops PNG polling once real pixels arrive.
- The presentation canvas survives normal updates, errors and reconnects.
  Switching desktop identity clears it so another Bot's image cannot persist.
- Connections have a 20-second first-frame deadline and bounded backoff. Four
  consecutive failures, or six failures within two minutes, trigger decoded PNG
  snapshots with an explicit retry control. A first frame alone does not reset
  the failure count: 30 seconds of stable viewing are required. Hidden pages
  close their stream and reconnect on return.
- Login expiry, lost ownership, stale assignment and protocol rejection stop
  automatic retries. Runtime/network/busy failures have bounded retries.
  Both transports expose the same sanitized, actionable error messages; raw
  provider messages are never passed into the viewer.
- Human takeover defaults to live noVNC control after the first visible frame.
  Dragging, keyboard input and wheel events use the same bounded RFB transport.
  Blur, hidden pages and connection loss close control and retain the poster.
  The user must select **Resume live control** to reconnect; input is not replayed.
- **Use snapshot control** retains the verified PNG alternative. Images decode
  before presentation and only then authorize the existing frame-bound input
  API. Errors/expiry invalidate input without erasing the displayed pixels.
- Model input retains the existing observed-frame API. Live pixels are never
  labelled as independently captured, verified PNG observations.

### Implemented phase: streaming human input

The user authorized this phase. The separate human-only stream follows these
requirements; native Windows acceptance remains outstanding:

1. Require explicit takeover and bind the authenticated owner, desktop generation
   and existing control lease to an opaque, short-lived session. Opening a viewer
   alone must never grant control.
2. Establish a distinct input contract for live human interaction; do not label
   VNC pixels as a PNG frame. The UI must show a ready live frame before enabling
   input and suspend input during reconnect, hidden-page or stale-generation
   transitions.
3. Validate every input batch against that session and current lease on the host.
   Bound keyboard/pointer queues; allow coalescing pointer movement but preserve
   ordering for button/key transitions. Never replay input after uncertain
   delivery.
4. Release held keys/buttons on blur, disconnect, lease revocation and give-back.
   Keep clipboard, file transfer, resizing and power control behind their
   existing independent capabilities.
5. Test takeover conflicts, drag ordering, scaling/coordinate alignment, Windows
   keyboard/IME behavior, disconnect while a button is down, rebind and stale
   session rejection before enabling this path.

Implementation contract:

- An explicit takeover token is passed only in the authenticated Fetch open
  body. The service binds one interactive viewer to that token, generation and
  desktop, validates it on every write, and renews it only while the viewer
  remains live. Other windows keep read-only viewers.
- Standard RFB key and pointer events are enabled only for that interactive
  stream. Clipboard, resize, power and extended input messages remain denied.
  The client enables input after its first frame; blur closes the input stream,
  and reconnect requires an explicit user resume. Input is never replayed.
- The Broker independently records whether the stream is interactive. Closing
  it sends tracked key/button releases over the original VNC connection, drains
  the relay, then clears and checks X11 key/button state. XTest alone cannot
  reliably release a button still owned by the VNC connection.
  New control streams and model actions wait for cleanup. Failed cleanup blocks
  reuse; explicit revocation stops an unreconciled guest before returning it to
  automation. A provider that does not acknowledge this capability cannot enable
  streamed control.
- The UI retains verified snapshot control as an explicit fallback. Snapshot
  input and an interactive stream cannot operate concurrently. Hiding, leaving,
  or closing a panel keeps the Bot paused.
- Unicode text uses noVNC's public key API, with a bounded input size, after
  control resumes. Native IME behavior still requires Windows acceptance.

## Packaging

The pinned `@novnc/novnc` 1.5.0 dependency is bundled into generated `client.js`.
The newer inspected releases use top-level await incompatible with this plugin's
classic-script build. `licenses/novnc/` includes MPL, pako MIT, author notices,
and an archive of the corresponding preferred core/pako source. The npm package
includes these and NOTICE. Runtime changes are made in root `computer-runtime/`
and copied into the generated plugin payload by the normal build.
The host WebSocket adapter uses the pinned MIT-licensed `ws` 8.22.0 dependency;
its license is also included under `licenses/ws/`.

## Verification

Automated coverage includes fragmented/combined handshake messages, forbidden
inputs, capability filtering, receive acknowledgement, cancellation, ownership
changes, model-turn continuity and stopping while a viewer is opening.

`ds-bot/dev/computer-stream-smoke.mjs` creates a separate labelled desktop and
volume through the real service/Broker, opens noVNC in Chromium, changes the
remote screen, forces a transport outage, and verifies the same presentation
canvas retains its pixels and resumes updates. Invalid PNG decode is also
checked, together with the absence of recurring full-frame copies. The fixture
also verifies live webpage clicks and Unicode text through independent HTTP
markers, scaled drag coordinates, held keys/buttons, cleanup on blur/disconnect,
manual resume, token replacement and give-back. It dismisses the desktop menu
opened by the observation check before testing the browser's input.
The fixture supports WebSocket, Fetch and deliberately rejected upgrade modes. It removes
only its own container, volume, browser and temporary home. Fixture auth tests
verify admission/revocation wiring; they do not establish acceptance of the
actual Windows shell's authentication carrier.

Example (prepared image and external browser test dependencies required):

```sh
CUA_TEST_IMAGE=sha256:<prepared-image-id> \
CUA_TEST_TRANSPORT=websocket \
CUA_BROWSER_DEPS=/path/to/test-dependencies \
CUA_CHROME=/path/to/chromium \
node ds-bot/dev/computer-stream-smoke.mjs
```

Windows GUI verification remains user-run: install the rebuilt plugin, watch
an animated/actively changing desktop, interrupt and restore transport, take
control, verify click/drag alignment and text entry, switch between live and
snapshot control, lose window focus while holding a key/button, resume manually,
then give control back. The GUI must retain
its image during refresh/reconnect and show the appropriate live/snapshot mode.

### Measured latency

`CUA_STREAM_REPORT=/path/to/report.json` optionally saves a successful fixture's
timings, environment and raw samples. Ten clicks alternate the color of a
dedicated remote button. Timing starts at the local `mousedown` and ends when
the expected pixel appears in noVNC's canvas; an independent guest HTTP marker
also confirms each click. This measures application-visible stream latency,
not merely transport acknowledgement or mouse cursor movement.

The November 1 WSL/Linux sample recorded input-to-frame p95 of 143 ms over
WebSocket, 159 ms over Fetch and 78 ms after a rejected WebSocket upgrade.
These are small, local synthetic-page samples, not a ranking or a platform SLA.
Cached guest startup, first frame, reconnect and input release are measured
separately. Data and limitations are in
`computer-runtime/evidence/stream-performance.json`; reproducible commands are
in [CUA verification](../dev/cua-verification.md).
