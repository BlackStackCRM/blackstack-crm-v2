# Windows Event Log — BlackStack CRM

## What it is

Critical, non-sensitive application events are written to the Windows
**Application** event log, source **"BlackStack CRM"**.

## When

- Startup failure requiring recovery (recovery-required, fail-closed states)
- Migration failure / recovery events
- Update failures requiring recovery
- Restore success / restore failure
- Critical crashes that don't reach the renderer

Never written: CRM data, secrets, tokens, file contents.

## How

A no-dependency wrapper around the `eventcreate` CLI
(`eventcreate /L APPLICATION /SO "BlackStack CRM" /T ERROR|WARNING|INFORMATION /ID <n> /D "<message>"`),
with graceful fallback to the file log if `eventcreate` is unavailable or
permission-denied (e.g. non-elevated contexts — it is used opportunistically
and never blocks startup).

## Where

- `electron/eventLog.js` — used by the startup-recovery / update-recovery
  paths in the main process.
- All events are also always written to `%APPDATA%\BlackStack CRM\logs\`
  and `updates.log` regardless of whether the Windows log write succeeds.

## Viewing

```powershell
Get-WinEvent -FilterHashtable @{ LogName='Application'; ProviderName='BlackStack CRM' } -MaxEvents 20
```

or Event Viewer → Windows Logs → Application → filter source "BlackStack CRM".

## Not implemented (honest)

- No custom event-log source registration (uses default `eventcreate`
  behavior; the source may appear as "Application" when the write fails in
  non-elevated contexts).
- No writing of Information-level routine events (start/shutdown) — file logs
  cover those.
