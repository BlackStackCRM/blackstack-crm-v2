# Release Checklist — BlackStack CRM Desktop

A production installer is approved only after every checked box below is
genuinely verified. Never publish a hash not calculated from the final
distributed binary (§33). Never produce the first installer merely because a
build command succeeded (§65).

## Version & build

- [ ] Version verified (package.json == server/version.js APP_VERSION)
- [ ] Production build generated (npm run electron:build:prod; signing gate passed)
- [ ] Installer generated (dist/BlackStack CRM Setup <version>.exe)
- [ ] Build recorded in installer/CHANGELOG.md

## Signing & integrity

- [ ] Code signature verified (Get-AuthenticodeSignature -> Status Valid, organization certificate)
- [ ] Authenticode signature verified with timestamp (signature survives cert expiry)
- [ ] SHA-256 calculated (npm run release:hash) from the FINAL binary
- [ ] SHA-256 recorded for the release page

## Installer behavior tests (real execution, not simulated)

- [ ] Installer tested (assisted wizard completes; UAC only when installing to Program Files)
- [ ] Fresh install tested (install -> launch -> create data -> restart -> data preserved)
- [ ] Reinstall tested (existing user-data reused, records intact) - run npm run acceptance:installer
- [ ] Update tested (old version -> create data -> update -> safe migration -> verified backup -> data intact) - run npm run acceptance:installer
- [ ] User-data preservation verified (%APPDATA%\BlackStack CRM never inside install dir)
- [ ] Uninstall preservation verified (binaries removed, user data intact)
- [ ] Silent installation tested (/S, /S /D= per silent-install.md)
- [ ] Single instance verified (second launch focuses existing window)
- [ ] Server binds 127.0.0.1 only (netstat -ano | findstr 34567)
- [ ] No firewall rule/prompt created
- [ ] PRAGMA integrity_check + foreign_key_check pass after every scenario

## Test suite

- [ ] Full vitest suite passing (existing + new tests)
- [ ] npm run acceptance:installer - all phases PASS

## Publication

- [ ] Release notes prepared (from release-notes-template.md when created)
- [ ] SHA-256 hash published on official release page
- [ ] Security documentation published
- [ ] Silent install documentation published (only tested switches)
- [ ] Backup/restore documentation published
- [ ] Documentation updated to match this build
- [ ] installer/CHANGELOG.md updated

## Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Build engineer | | | |
| QA | | | |
| Release approver | | | |
