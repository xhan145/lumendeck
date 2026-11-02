# LumenDeck Recovery Watchdog

The recovery watchdog is an independent Rust executable intended to remain available even when the main LumenDeck runtime fails.

## Current development behavior

LumenDeck writes a heartbeat under:

`%LOCALAPPDATA%\LumenDeck\recovery\heartbeat`

The watchdog records events in:

`%LOCALAPPDATA%\LumenDeck\recovery\watchdog.log`

Build the development watchdog with:

```powershell
npm run recovery:build
```

Then restart LumenDeck. The **System > Shell** page reports whether the watchdog launched and shows its PID and paths.

## Safety boundary

Desktop mode is deliberately conservative:

- stale heartbeat is logged only
- a hung process is not killed automatically
- Explorer is not restarted merely because a heartbeat is stale
- no registry or Winlogon settings are modified

Explorer fallback is enabled only when the main process explicitly starts the watchdog in shell mode by setting:

```text
LUMENDECK_SHELL_MODE=1
```

That flag is reserved for future controlled shell-replacement testing. It must not be enabled on a primary Windows account until recovery, rollback, and shell takeover gates are complete.

## Failure semantics

The watchdog polls the parent process every two seconds and considers the heartbeat stale after twelve seconds.

If the parent process exits:

- desktop mode: log the exit and stop
- shell mode: request `explorer.exe` launch, log the result, then stop

A stale heartbeat alone never causes process termination or shell replacement.

## Still required before shell takeover

- package the watchdog with installers
- clean-exit marker and crash-loop counter
- safe-mode startup
- last-known-good configuration
- persistent policy/audit storage
- recovery hotkey or launcher that does not depend on the main UI
- verified Windows build/test CI
- disposable/test-account Explorer-less validation
