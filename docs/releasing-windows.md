# Windows Electron releases

Use the release wrapper for Windows Electron releases:

```powershell
npm run electron:release:win:fix
```

The wrapper reads the release version from `package.json`, removes stale
top-level update manifests, installers, and blockmaps, then builds locally with
`--publish never`. It does not ask electron-builder to publish or create a
release. When `CSC_LINK` and `CSC_KEY_PASSWORD` are set, the strict signing gate
is run and electron-builder enforces signing; otherwise it builds an unsigned
test installer and prints a warning. Unsigned installers are less trusted by
Windows and should only be used when that tradeoff is intended.

This project currently sets `build.win.verifyUpdateCodeSignature` to `false`
for unsigned local testing. This setting is embedded in each newly built app's
`resources/app-update.yml`; it does not change the verifier in an already
installed older app. Therefore an installed 1.0.5 client that embeds the
`ContactBridge Systems` publisher will still reject an unsigned 1.0.7 installer.
To bootstrap such a client, install 1.0.7 manually once (or publish a 1.0.7
installer signed with the same publisher). After the unsigned 1.0.7 is installed,
its updater can use the new opt-out for later test updates.

After building, the wrapper reads the installer filename from the fresh manifest,
renames the installer and its blockmap to match, and verifies the installer size
and SHA-512 against the manifest. It then uses GitHub CLI to upload all three
assets with `--clobber`. If the remote tag exists but has no release yet, it
creates a release using that tag; an existing release with zero or partial assets
is repaired by the same upload. It verifies that the installer, blockmap, and
`stable.yml` are present before reporting success.

The upload is equivalent to:

```powershell
gh release upload "v<package-version>" "dist/stable.yml" --clobber
```

Before running, make sure the GitHub CLI is authenticated (`gh auth status`).
For a signed release, also set `CSC_LINK` and `CSC_KEY_PASSWORD`. The builder's
publish configuration must keep `channel: "stable"` aligned with the Electron
updater's stable channel. Release each version only once; bump `package.json`
