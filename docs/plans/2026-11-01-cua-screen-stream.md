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
  -> authenticated DSH connection.fetch POST route
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

The adapter uses a long-poll downlink and a separate serialized uplink. These
carry RFB bytes, **not screenshots**. This avoids depending on a WebSocket server
that the Windows shell may not expose, and does not require patching DSH.
Requests wait up to 20 seconds when no bytes are available and return immediately
when there is data. Each completed read is acknowledged by the next read.

This is not video/WebRTC. noVNC retains its incremental decoder; the integration
copies its public `getImageData()` output to a persistent presentation canvas at
up to approximately 15 fps. This costs a framebuffer copy, but avoids relying on
noVNC's private fields or its decoder canvas surviving disconnect. A future
public noVNC frame event could reduce these copies.

## Bounds and authorization

- One downstream Broker chunk (at most 64 KiB) is in flight per viewer. Its
  subprocess stdout is paused until acknowledged. The route queue is bounded
  to 128 KiB and the browser uplink to 64 KiB.
- Each uplink waits for the subprocess stdin write callback. The Python relay
  has bounded buffers, handles partial writes, and exits on stdin EOF.
- At most four viewers per desktop and sixteen per Broker/route are admitted.
- Server parsing validates fragmented RFB 3.8 / None / shared-client handshake.
  Only pixel format, encoding negotiation, framebuffer requests, continuous
  updates and bounded fence messages are forwarded. Key, pointer, clipboard,
  resize, power and unknown message types close the viewer. Control-related
  capability advertisements are removed. Browser `viewOnly` is additional UI
  behavior, not the authorization boundary.
- Pending opens are registered before awaiting the provider and revalidated
  afterwards. Stop, rebind, archive and disposal close pending and live viewers.
  Normal model end-turn fence revocation does not tear down observation.
- Ownership/generation/recovery is checked on exchanges and periodically.
  Abandoned routes expire after 45 seconds. Active viewers prevent idle shutdown;
  closing the panel never releases human control or stops the desktop.

## Display and human control

- Normal observation uses RFB and stops PNG polling once real pixels arrive.
- The presentation canvas survives normal updates, errors and reconnects.
  Switching desktop identity clears it so another Bot's image cannot persist.
- Connections have a 20-second first-frame deadline and bounded backoff. After
  four consecutive failures, decoded PNG snapshots are shown, with an explicit
  retry control. Hidden pages close their stream and reconnect on return.
- **Human takeover uses visibly displayed, verified PNG snapshots**, decoded
  before drawing. Clicks, keys and scroll still use the existing frame-bound
  `computer-input` API. New frames are authorized only after presentation, and
  errors/expiry invalidate input without erasing the last displayed pixels.
- The live stream is read-only. Its pixels must never be treated as if they were
  the independently captured frame used to authorize human input.

The initial scope therefore improves live observation and removes blanking in
human control. It does not provide direct interactive VNC input. That would need
a separate design preserving the existing input lease and frame-binding rules.

## Packaging

The pinned `@novnc/novnc` 1.5.0 dependency is bundled into generated `client.js`.
The newer inspected releases use top-level await incompatible with this plugin's
classic-script build. `licenses/novnc/` includes MPL, pako MIT, author notices,
and an archive of the corresponding preferred core/pako source. The npm package
includes these and NOTICE. Runtime changes are made in root `computer-runtime/`
and copied into the generated plugin payload by the normal build.

## Verification

Automated coverage includes fragmented/combined handshake messages, forbidden
inputs, capability filtering, receive acknowledgement, cancellation, ownership
changes, model-turn continuity and stopping while a viewer is opening.

`ds-bot/dev/computer-stream-smoke.mjs` creates a separate labelled desktop and
volume through the real service/Broker, opens noVNC in Chromium, changes the
remote screen, forces a transport outage, and verifies the same presentation
canvas retains its pixels and resumes updates. Invalid PNG decode is also
checked. It removes only its own container, volume, browser and temporary home.
The fixture HTTP adapter is not evidence of DSH authentication; that boundary
is supplied by the documented owner-only Fetch registry.

Example (prepared image and external browser test dependencies required):

```sh
CUA_TEST_IMAGE=sha256:<prepared-image-id> \
CUA_BROWSER_DEPS=/path/to/test-dependencies \
CUA_CHROME=/path/to/chromium \
node ds-bot/dev/computer-stream-smoke.mjs
```

Windows GUI verification remains user-run: install the rebuilt plugin, watch
an animated/actively changing desktop, interrupt and restore transport, take
control, verify click alignment, then give control back. The GUI must retain
its image during refresh/reconnect and show the appropriate live/snapshot mode.
