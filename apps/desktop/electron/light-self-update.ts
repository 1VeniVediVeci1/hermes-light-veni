import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { app, net } from 'electron'

import type { UpdaterApplyResultWire, UpdaterStatusWire } from './updater'

const REPO = '1VeniVediVeci1/hermes-light-veni'
const ASSET = 'HermesLight-win-x64.zip'
const EXE = 'Hermes Light.exe'
const TAG = /^light-\d{8}-\d{6}$/
const STAGE_NAME = /^(light-\d{8}-\d{6})(?:\.partial)?$/
const HEADERS = { 'User-Agent': 'Hermes-Light-Portable-Updater' }
const runFile = promisify(execFile)

interface LightRelease {
  tag: string
  url: string
  size: number
  sha256?: string
}

// Accept only the portable release contract, not arbitrary paths or download URLs from JSON.
export function selectLightRelease(value: unknown, ownTag: string): LightRelease | null {
  const release = value as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown }
  const tag = release?.tag_name
  if (typeof tag !== 'string' || !TAG.test(tag) || release.draft || release.prerelease || tag <= ownTag) {
    return null
  }
  const url = `https://github.com/${REPO}/releases/download/${tag}/${ASSET}`
  const asset = Array.isArray(release.assets) ? release.assets.find(item => item?.name === ASSET) : undefined
  if (!asset || asset.browser_download_url !== url || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
    throw new Error(`Missing or invalid portable asset for ${tag}`)
  }
  const digest = asset.digest
  if (digest != null && (typeof digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(digest))) {
    throw new Error(`Invalid portable asset digest for ${tag}`)
  }
  return { tag, url, size: asset.size, sha256: digest?.slice(7).toLowerCase() }
}

async function readOwnTag(): Promise<string | null> {
  const stamp = await readFile(path.join(process.resourcesPath, 'light-release.json'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (stamp === null) return null
  const info = JSON.parse(stamp.replace(/^\uFEFF/, ''))
  if (typeof info?.tag !== 'string' || !TAG.test(info.tag) || info.repo !== REPO || info.asset !== ASSET) {
    throw new Error('Invalid light-release.json')
  }
  return info.tag
}

function isWithin(dir: string, target: string): boolean {
  const relative = path.relative(dir, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function assertPayload(dir: string): Promise<void> {
  const payload = path.join(dir, 'HermesLight')
  if (!(await lstat(payload)).isDirectory() || !(await lstat(path.join(payload, EXE))).isFile()) {
    throw new Error('Missing HermesLight/Hermes Light.exe in portable update')
  }
}

async function assertArchive(zip: string, release: LightRelease): Promise<void> {
  const info = await lstat(zip)
  if (!info.isFile() || info.size !== release.size) throw new Error('Portable asset size mismatch')
  if (release.sha256) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(zip)) hash.update(chunk)
    if (hash.digest('hex') !== release.sha256) throw new Error('Portable asset SHA-256 mismatch')
  }
}

async function stageRelease(root: string, release: LightRelease, system32: string, log: (message: string) => void) {
  const stage = path.join(root, release.tag)
  const partial = `${stage}.partial`
  try {
    if (!(await lstat(stage)).isDirectory()) throw new Error('Invalid staging directory')
    await assertPayload(path.join(stage, 'payload'))
    await assertArchive(path.join(stage, ASSET), release)
    return stage
  } catch (error) {
    if (error.code !== 'ENOENT') log(`[light-update] discarding invalid staging: ${error}`)
    await rm(stage, { recursive: true, force: true })
  }

  await rm(partial, { recursive: true, force: true })
  const payload = path.join(partial, 'payload')
  await mkdir(payload, { recursive: true })
  try {
    const zip = path.join(partial, ASSET)
    const signal = AbortSignal.timeout(30 * 60_000)
    const response = await net.fetch(release.url, { headers: HEADERS, credentials: 'omit', cache: 'no-store', signal })
    if (!response.ok || !response.body) throw new Error(`Portable asset download: HTTP ${response.status}`)
    let bytes = 0
    await pipeline(
      response.body,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.byteLength
          if (bytes > release.size) throw new Error('Portable asset exceeds announced size')
          yield chunk
        }
      },
      createWriteStream(zip, { flags: 'wx' }),
      { signal }
    )
    await assertArchive(zip, release)
    await runFile(path.join(system32, 'tar.exe'), ['-xf', zip, '-C', payload], { windowsHide: true, timeout: 600_000 })
    const entries = await readdir(payload)
    if (entries.length !== 1 || entries[0] !== 'HermesLight') throw new Error('Unexpected portable ZIP layout')
    await assertPayload(payload)
    // Only a verified, completely extracted directory is visible to the next launch.
    await rename(partial, stage)
    return stage
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(cleanup => log(`[light-update] ${cleanup}`))
    throw error
  }
}

// Variable paths arrive through the environment (or, for the UAC pass, as -File arguments);
// they never become PowerShell source or cmd text.
const SWAP_SCRIPT = String.raw`param([int]$AppPid = $env:HERMES_LIGHT_SWAP_PID, [string]$InstallDir = $env:HERMES_LIGHT_SWAP_DIR, [string]$Tag = $env:HERMES_LIGHT_SWAP_TAG, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'payload\HermesLight'
$zip = Join-Path $PSScriptRoot 'HermesLight-win-x64.zip'
$log = Join-Path $PSScriptRoot 'swap.log'
$exe = Join-Path $InstallDir 'Hermes Light.exe'
$old = "$InstallDir.old-$Tag"
$prefix = $InstallDir + '\'
$waited = $false

function Write-Log($Message) {
  try { Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) $Message" } catch { }
}
function Test-AppRunning {
  if (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) { return $true }
  foreach ($process in (Get-Process -Name 'Hermes Light' -ErrorAction SilentlyContinue)) {
    if ($process.Path -and $process.Path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}
function Test-AccessDenied($Record) {
  # Directory.Move reports ERROR_ACCESS_DENIED as an IOException carrying E_ACCESSDENIED.
  for ($e = $Record.Exception; $e; $e = $e.InnerException) {
    if ($e -is [UnauthorizedAccessException] -or $e.HResult -eq -2147024891) { return $true }
  }
  return $false
}
function Start-App {
  # Start-Process on Windows PowerShell can treat brackets in WorkingDirectory as wildcards.
  $launch = New-Object Diagnostics.ProcessStartInfo
  $launch.FileName = $exe
  $launch.WorkingDirectory = $InstallDir
  $launch.UseShellExecute = $false
  [void][Diagnostics.Process]::Start($launch)
}
# Copy, swap and drop the backup. Restores the previous install before rethrowing.
function Install-Payload {
  $next = "$InstallDir.new-$Tag-$([Guid]::NewGuid().ToString('N'))"
  $backedUp = $false
  try {
    # Staging can be on another drive. Copy to a sibling first, then expose only the complete package.
    Copy-Item -LiteralPath $source -Destination $next -Recurse -Force
    if (Test-AppRunning) { throw 'Hermes Light reopened before the swap' }
    [IO.Directory]::Move($InstallDir, $old)
    $backedUp = $true
    Write-Log "Renamed install to $old"
    [IO.Directory]::Move($next, $InstallDir)
  } catch {
    $failure = $_
    if ($backedUp) {
      try {
        [IO.Directory]::Move($old, $InstallDir)
        Write-Log 'Restored previous installation'
      } catch {
        Write-Log "Recovery failed: $_ (backup: $old)"
      }
    }
    throw $failure
  } finally {
    if ([IO.Directory]::Exists($next)) {
      try { [IO.Directory]::Delete($next, $true) } catch { Write-Log "Candidate cleanup failed: $_" }
    }
  }
  try { [IO.Directory]::Delete($old, $true) } catch { Write-Log "Cleanup failed for '$old': $_" }
}

# Administrator pass: only touches the install directory; the user-level pass launches the app.
if ($Elevated) {
  try { Install-Payload; exit 0 } catch { Write-Log "Administrator update failed: $_"; exit 1 }
}

Write-Log "Waiting for $AppPid and other Hermes Light processes under $InstallDir"
try {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while (Test-AppRunning) {
    if ($clock.Elapsed.TotalSeconds -ge 120) { throw 'Timed out waiting for Hermes Light to exit' }
    Start-Sleep -Milliseconds 250
  }
  $waited = $true
  if ((Test-Path -LiteralPath $old) -or !(Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Unexpected install or backup path' }
  if (!(Test-Path -LiteralPath (Join-Path $source 'Hermes Light.exe') -PathType Leaf)) { throw 'Staged executable missing' }

  try {
    Install-Payload
  } catch {
    # Installs under Program Files need administrator rights to rename; ask UAC once and retry.
    if (!(Test-AccessDenied $_)) { throw }
    Write-Log "Access denied, requesting administrator rights: $($_.Exception.Message)"
    $q = [char]34
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass ' +
      "-File $q$PSCommandPath$q -Elevated -AppPid $AppPid -InstallDir $q$InstallDir$q -Tag $q$Tag$q"
    try {
      $admin = Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    } catch {
      throw "Administrator approval was not granted: $($_.Exception.Message)"
    }
    if ($admin.ExitCode -ne 0) { throw "Administrator update failed (exit $($admin.ExitCode))" }
  }
  Start-App
} catch {
  Write-Log "Update failed: $_"
  if ($waited -and !(Test-AppRunning) -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
    try { Start-App } catch { Write-Log "Relaunch failed: $_" }
  }
  exit 1
}

Write-Log 'Replacement launched'
try { [IO.Directory]::Delete($source, $true) } catch { Write-Log "Cleanup failed for '$source': $_" }
try { Remove-Item -LiteralPath $zip -Force } catch { Write-Log "ZIP cleanup failed: $_" }
`

interface LightUpdateOptions {
  light: boolean
  primary: boolean
  isQuitting: () => boolean
  quitForHandoff: () => void
  onStatus: (status: UpdaterStatusWire) => void
  log: (message: string) => void
}

interface StagedUpdate {
  tag: string
  stage: string
  installDir: string
  system32: string
  /** Why the last swap of this stage failed, from its swap.log. */
  lastFailure?: string
}

/** The failure reason of the most recent swap attempt recorded in a stage's swap.log. */
export function lastSwapFailure(logText: string): string | undefined {
  const lines = logText.split(/\r?\n/)
  const attempt = lines.findLastIndex(line => / Waiting for \d+ /.test(line))
  if (attempt < 0) return undefined
  for (const line of lines.slice(attempt + 1)) {
    const failure = / (?:Administrator update|Update) failed: (.+)$/.exec(line)
    if (failure) return failure[1].slice(0, 300)
  }
  return undefined
}

const RECHECK_MS = 6 * 60 * 60 * 1000

export function createLightSelfUpdater({ light, primary, isQuitting, quitForHandoff, onStatus, log }: LightUpdateOptions) {
  if (process.platform !== 'win32' || !app.isPackaged || !light || !primary) return null
  if (process.env.HERMES_LIGHT_DISABLE_UPDATES === '1') return null

  let pending: StagedUpdate | null = null
  let checking: Promise<void> | null = null
  let applying = false
  let status: UpdaterStatusWire = { supported: true, mechanism: 'light-portable', updateAvailable: false }

  async function refresh(): Promise<void> {
    const ownTag = await readOwnTag()
    if (ownTag === null) {
      if (status.supported) {
        status = { ...status, supported: false }
        onStatus(status)
      }
      return
    }
    if (isQuitting()) return
    // Keep checking the release feed with a pending offer, but never stage its tag again.
    const release = await findNewRelease(pending?.tag ?? ownTag)
    if (applying || isQuitting()) return
    if (!release) {
      status = { ...status, fetchedAt: Date.now() }
      return
    }

    const candidate = await prepareUpdate(release, log)
    if (applying || isQuitting()) return
    pending = candidate
    status = {
      ...status,
      supported: true,
      updateAvailable: true,
      latestTag: candidate.tag,
      message: candidate.lastFailure,
      fetchedAt: Date.now()
    }
    onStatus(status)
    // Only clean up after the new stage is ready and owns the offer, so a failed
    // download never invalidates the previous offer or races an apply of it.
    await pruneOlderStages(path.dirname(candidate.stage), candidate.tag, log)
  }

  async function check({ force = false } = {}): Promise<UpdaterStatusWire> {
    if (force && !applying && !isQuitting()) {
      checking ??= refresh()
        .catch(error => log(`[light-update] ${error}`))
        .finally(() => { checking = null })
      await checking
    }
    return status
  }

  let started = false
  function start(): void {
    if (started) return
    started = true
    const tick = () => {
      if (!checking) void check({ force: true })
    }
    setTimeout(() => {
      tick()
      setInterval(tick, RECHECK_MS).unref()
    }, 4_000).unref()
  }

  async function apply(): Promise<UpdaterApplyResultWire> {
    if (applying || isQuitting()) return { ok: false, error: 'update-in-flight' }
    if (!pending) return { ok: true, updateAvailable: false }
    applying = true
    try {
      if (!await launchSwap(pending, isQuitting)) return { ok: false, error: 'app-quitting' }
      quitForHandoff()
      return { ok: true, handedOff: true }
    } catch (error) {
      log(`[light-update] updater launch failed: ${error}`)
      return { ok: false, error: 'apply-failed' }
    } finally {
      applying = false
    }
  }

  return { start, check, apply }
}

async function findNewRelease(ownTag: string): Promise<LightRelease | null> {
  const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { ...HEADERS, Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Latest release check: HTTP ${response.status}`)
  return selectLightRelease(await response.json(), ownTag)
}

async function prepareUpdate(release: LightRelease, log: LightUpdateOptions['log']): Promise<StagedUpdate> {
  const installDir = await realpath(path.dirname(process.execPath))
  const root = path.join(await realpath(app.getPath('temp')), 'HermesLightUpdate')
  const userData = await realpath(app.getPath('userData'))
  if (installDir === path.parse(installDir).root || isWithin(installDir, root) ||
      isWithin(root, installDir) || isWithin(installDir, userData)) {
    throw new Error('Portable install must be a separate directory from the update cache and user data')
  }
  const system32 = path.join(process.env.SystemRoot, 'System32')
  await mkdir(root, { recursive: true })
  if (!(await lstat(root)).isDirectory()) throw new Error('Invalid update cache directory')
  const stage = await stageRelease(root, release, system32, log)
  const swapLog = await readFile(path.join(stage, 'swap.log'), 'utf8').catch(() => '')
  return { tag: release.tag, stage, installDir, system32, lastFailure: lastSwapFailure(swapLog) }
}

async function pruneOlderStages(root: string, tag: string, log: LightUpdateOptions['log']): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const stagedTag = STAGE_NAME.exec(entry.name)?.[1]
    if (entry.isDirectory() && stagedTag && stagedTag < tag) {
      await rm(path.join(root, entry.name), { recursive: true, force: true }).catch(error => log(`[light-update] ${error}`))
    }
  }
}

async function launchSwap({ stage, installDir, system32, tag }: StagedUpdate, isQuitting: () => boolean): Promise<boolean> {
  const script = path.join(stage, 'swap.ps1')
  await writeFile(script, SWAP_SCRIPT)
  if (isQuitting()) return false
  // A detached powershell.exe has no console and exits 0 without running the script, while a
  // non-detached child dies with Electron's job object. `start` gives it a fresh console outside
  // that job. Paths travel in the environment so cmd never parses them (only the stage path does).
  const powershell = path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = `start "" /min "${powershell}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden ` +
    `-ExecutionPolicy Bypass -File "${script}"`
  const child = spawn(path.join(system32, 'cmd.exe'), ['/d', '/s', '/c', `"${command}"`], {
    cwd: stage,
    detached: true,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      HERMES_LIGHT_SWAP_PID: String(process.pid),
      HERMES_LIGHT_SWAP_DIR: installDir,
      HERMES_LIGHT_SWAP_TAG: tag
    }
  })
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve(true)
    })
  })
}
