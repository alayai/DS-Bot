# Publish and promote a CUA desktop image

The source lock currently has no published image. First-time setup still builds
the pinned recipe locally. These steps prepare a release; they do not upgrade
existing desktops or publish anything automatically.

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
