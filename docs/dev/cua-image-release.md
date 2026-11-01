# Publish and promote a CUA desktop image

The source lock now pins a tested GitHub Release archive. First-time setup
downloads and verifies it; existing desktops retain their original image.
The GHCR process below remains available for a later release. The archive
process is described at the end. Promotion never upgrades an existing home.

## 1. Build a candidate from committed source

Commit the runtime, image workflow, release script and smoke changes on the
release branch. Run **Computer image candidate** at that commit with `publish`
disabled first. It builds Linux amd64, checks the image, exercises screenshot,
file roundtrip, checkpoint and restart, and produces `computer-image-build-evidence`.

The smoke report is written only after fixture cleanup succeeds. Cancellation
cannot produce passing release evidence. The SBOM inventories installed packages;
it is not a license/distribution approval.

## 2. Publish and prove anonymous download

Run the same workflow at the accepted commit with `publish` enabled. This pushes
`ghcr.io/OWNER/REPOSITORY/cua-desktop:sha-COMMIT` and resolves its immutable digest.
The token is passed through stdin and the publishing job logs out afterward.

A separate fresh runner then pulls that digest with an empty Docker configuration,
without logging in. Its inspected image ID must equal the image exercised by the
smoke. This must succeed before `computer-image-evidence` is produced.

If the package is private, the anonymous job fails. An authorized repository owner
must decide whether to make that GHCR package public, then rerun the failed job.
The workflow never changes visibility. Do not promote the build-only artifact.

## 3. Review and import evidence

Download `computer-image-evidence` from that trusted successful workflow run.
Check the run repository and full commit independently in GitHub; candidate
metadata and checksums are consistency evidence, not a signature or independent
proof of origin. Do not accept artifacts from an unknown sender.

From the project root, substitute the artifact directory, expected repository and
full 40-character source commit:

```sh
node ds-bot/scripts/computer-image-release.mjs verify /path/to/evidence OWNER/REPOSITORY FULL_COMMIT
node ds-bot/scripts/computer-image-release.mjs promote /path/to/evidence OWNER/REPOSITORY FULL_COMMIT
```

`verify` is read-only. `promote` repeats verification, then atomically updates
only `computer-runtime/runtime.lock.json`. It records the registry digest,
tested image ID and recipe hash. Repository/commit mismatch, changed evidence,
different recipe, missing smoke coverage, mismatched inventory or incompatible
image metadata refuse promotion without changing the lock.

This imports source configuration only. It does not commit, push, start a guest,
touch DSH data, or migrate existing homes. Review the lock diff before packaging.
Do not manually paste a mutable tag or invent a digest.

## 4. Build and exercise the actual distribution

```sh
cd ds-bot
npm run build
npm test
node scripts/build-client.mjs --check
node scripts/build-computer-runtime.mjs --check
npm run lint
```

On a clean test engine, use the installed payload setup smoke without an image ID:

```sh
node ds-bot/dev/computer-setup-smoke.mjs
```

This exercises first preparation through the plugin's digest pull path. Passing
an image ID instead exercises only a cached image and cannot prove first download.
Test Windows Desktop separately. Keep all tests in isolated homes/engines and
leave the user's DSH data and existing desktops alone.

Fresh setup verifies the downloaded ID against the tested ID. Pull failure stays
visible and retryable; it does not silently switch to local building. Existing
desktops keep their original pinned image after a plugin update.

## GitHub Release archive delivery

`computer-image-release.yml` provides an alternative when anonymous GHCR access
is unavailable. Push reviewed source to `codex/cua-image-release`, or dispatch the
workflow at the reviewed commit. It builds and exercises the same desktop, exports
a gzip Docker archive, and publishes 256 MiB parts in a preview GitHub Release.
The manifest pins every part's byte length and SHA-256, the image ID and recipe.
A second runner with an empty image cache downloads anonymously, verifies all
bytes, loads the image and repeats the desktop smoke. No registry credentials
are needed by the installer. A private repository cannot pass anonymous delivery.

Only a successful verification creates
`codex/cua-image-evidence-FULL_SOURCE_COMMIT`, whose sole additional commit pins
`computer-runtime/runtime.lock.json`. Check that its parent is the intended source
commit and its recipe matches the current desktop before importing that lock.
The result branch `codex/cua-image-result-FULL_SOURCE_COMMIT-RUN_ID` records the
publish/verify outcomes for operators using SSH Git without GitHub API access.
A release or result branch alone is not approval to promote the lock.

Published assets are not overwritten on a rerun. An existing manifest must match
exactly. If a failed release contains incomplete or different assets, investigate
it and publish a new reviewed source commit instead of force-pushing evidence.
The source development branch is never moved by the workflow. Successful
publication still needs the lock imported, generated payload rebuilt and a new
plugin package; existing installations retain their original image pin.

The loader allows at most 8 GiB, rejects malformed manifests and incomplete,
changed or oversized parts, checks temporary free disk space and cleans its own
temporary files after success, error or cancellation. It never extracts the
archive on the host. Download errors remain visible and retryable; they do not
silently fall back to building a different image.
