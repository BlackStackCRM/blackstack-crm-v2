# Windows Electron releases

Use the release wrapper for Windows Electron releases:

```powershell
npm run electron:release:win:fix
```

The wrapper reads the release version from `package.json`, builds and publishes
the Windows installer, then uploads the update manifest. When `CSC_LINK` and
`CSC_KEY_PASSWORD` are set, it uses the strict signed release script. If they
are absent, it uses the explicitly authorized unsigned path and prints a clear
warning. The unsigned path invokes electron-builder through npm's CLI with its
config argument passed as a single argument, avoiding PowerShell parsing issues.
Unsigned installers are less trusted by Windows and should only be used when
that tradeoff is intended.

This project currently sets `build.win.verifyUpdateCodeSignature` to `false`
for unsigned local testing. This setting is embedded in each newly built app's
`resources/app-update.yml`; it does not change the verifier in an already
installed older app. Therefore an installed 1.0.5 client that embeds the
`ContactBridge Systems` publisher will still reject an unsigned 1.0.7 installer.
To bootstrap such a client, install 1.0.7 manually once (or publish a 1.0.7
installer signed with the same publisher). After the unsigned 1.0.7 is installed,
its updater can use the new opt-out for later test updates.

The final upload is equivalent to:

```powershell
gh release upload "v<package-version>" "dist/stable.yml" --clobber
```

The upload is intentional even when electron-builder already uploaded the
manifest. `--clobber` replaces the release asset with the local build's manifest,
so the stable channel's expected `stable.yml` is present after the command
finishes. If the builder generated only `latest.yml`, the wrapper copies it to
`stable.yml` before uploading; if neither manifest exists or it is empty, the
wrapper fails instead of reporting a successful release without update metadata.

Before running, make sure the GitHub CLI is authenticated (`gh auth status`).
For a signed release, also set `CSC_LINK` and `CSC_KEY_PASSWORD`. The builder's
publish configuration must keep `channel: "stable"` aligned with the Electron
updater's stable channel. Release each version only once; bump `package.json`
and create/push its matching `v<version>` tag before publishing.
