import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

import { app } from 'electron'

// High (elevated administrator) or System mandatory integrity level in `whoami /groups`.
const ELEVATED_INTEGRITY = /S-1-16-(?:12288|16384)\b/

/** Quote one argument so CommandLineToArgvW returns it unchanged. */
export function quoteWindowsArg(arg: string): string {
  if (arg !== '' && !/[\s"]/.test(arg)) return arg
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

// Waits for this process to exit (so the single-instance lock is free), then asks UAC to start
// the same executable elevated. Values travel in the environment; the command is base64.
const ELEVATE_COMMAND = [
  'Wait-Process -Id $env:HERMES_LIGHT_ELEVATE_PID -ErrorAction SilentlyContinue',
  '$launch = @{ FilePath = $env:HERMES_LIGHT_ELEVATE_EXE; Verb = "RunAs"; WorkingDirectory = $env:HERMES_LIGHT_ELEVATE_CWD }',
  'if ($env:HERMES_LIGHT_ELEVATE_ARGS) { $launch.ArgumentList = $env:HERMES_LIGHT_ELEVATE_ARGS }',
  'Start-Process @launch'
].join('\n')

/**
 * Hermes Light runs as administrator on Windows. When a packaged Light build starts without
 * elevation, hand off to a UAC relaunch and return true: the caller must exit without taking
 * the single-instance lock. Declining UAC leaves nothing running, like a requireAdministrator
 * manifest. `HERMES_LIGHT_ELEVATE=0` opts out.
 */
export function relaunchLightElevated(light: boolean, log: (message: string) => void): boolean {
  if (process.platform !== 'win32' || !app.isPackaged || !light) return false
  if (process.env.HERMES_LIGHT_ELEVATE === '0') return false

  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
  const groups = spawnSync(path.join(system32, 'whoami.exe'), ['/groups'], { encoding: 'utf8', windowsHide: true })
  if (groups.status !== 0) {
    log(`[light-elevate] cannot read the token integrity level; continuing unelevated: ${groups.error ?? groups.stderr}`)
    return false
  }
  if (ELEVATED_INTEGRITY.test(groups.stdout)) return false

  const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encoded = Buffer.from(ELEVATE_COMMAND, 'utf16le').toString('base64')
  // A detached powershell.exe without a console exits without running; `start` gives it one.
  const command = `start "" /min "${powershell}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`
  try {
    const child = spawn(path.join(system32, 'cmd.exe'), ['/d', '/s', '/c', `"${command}"`], {
      detached: true,
      env: {
        ...process.env,
        HERMES_LIGHT_ELEVATE_PID: String(process.pid),
        HERMES_LIGHT_ELEVATE_EXE: process.execPath,
        HERMES_LIGHT_ELEVATE_CWD: process.cwd(),
        HERMES_LIGHT_ELEVATE_ARGS: process.argv.slice(1).map(quoteWindowsArg).join(' ')
      },
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true
    })
    child.unref()
    return true
  } catch (error) {
    log(`[light-elevate] elevated relaunch failed; continuing unelevated: ${error}`)
    return false
  }
}
