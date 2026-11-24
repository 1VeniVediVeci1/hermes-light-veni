import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { app, dialog, net, type BrowserWindow } from 'electron'

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

// All variable paths arrive as separate -File arguments; they never become PowerShell source.
const SWAP_SCRIPT = String.raw`param([int]$AppPid, [string]$InstallDir, [string]$Tag)
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'payload\HermesLight'
$zip = Join-Path $PSScriptRoot 'HermesLight-win-x64.zip'
$log = Join-Path $PSScriptRoot 'swap.log'
$exe = Join-Path $InstallDir 'Hermes Light.exe'
$old = "$InstallDir.old-$Tag"
$next = "$InstallDir.new-$Tag-$([Guid]::NewGuid().ToString('N'))"
$prefix = $InstallDir + '\'
$backedUp = $false
$installed = $false
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
function Start-App {
  # Start-Process on Windows PowerShell can treat brackets in WorkingDirectory as wildcards.
  $launch = New-Object Diagnostics.ProcessStartInfo
  $launch.FileName = $exe
  $launch.WorkingDirectory = $InstallDir
  $launch.UseShellExecute = $false
  [void][Diagnostics.Process]::Start($launch)
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

  # Staging can be on another drive. Copy to a sibling first, then expose only the complete package.
  Copy-Item -LiteralPath $source -Destination $next -Recurse -Force
  if (Test-AppRunning) { throw 'Hermes Light reopened before the swap' }
  [IO.Directory]::Move($InstallDir, $old)
  $backedUp = $true
  Write-Log "Renamed install to $old"
  [IO.Directory]::Move($next, $InstallDir)
  $installed = $true
  Start-App
} catch {
  Write-Log "Update failed: $_"
  try {
    if ($backedUp) {
      if ($installed) { [IO.Directory]::Move($InstallDir, $next) }
      [IO.Directory]::Move($old, $InstallDir)
      Write-Log 'Restored previous installation'
    }
    if ($waited -and !(Test-AppRunning) -and (Test-Path -LiteralPath $exe -PathType Leaf)) { Start-App }
  } catch {
    Write-Log "Recovery failed: $_ (backup: $old)"
  }
  exit 1
} finally {
  if ([IO.Directory]::Exists($next)) {
    try { [IO.Directory]::Delete($next, $true) } catch { Write-Log "Candidate cleanup failed: $_" }
  }
}

Write-Log 'Replacement launched'
foreach ($dir in @($old, $source)) {
  try { [IO.Directory]::Delete($dir, $true) } catch { Write-Log "Cleanup failed for '$dir': $_" }
}
try { Remove-Item -LiteralPath $zip -Force } catch { Write-Log "ZIP cleanup failed: $_" }
`

interface LightUpdateOptions {
  light: boolean
  primary: boolean
  window: BrowserWindow
  isQuitting: () => boolean
  quitForHandoff: () => void
  log: (message: string) => void
}

let scheduled = false

export function scheduleLightSelfUpdate(options: LightUpdateOptions): void {
  if (scheduled || process.platform !== 'win32' || !app.isPackaged || !options.light || !options.primary) return
  if (process.env.HERMES_LIGHT_DISABLE_UPDATES === '1') return
  scheduled = true
  setTimeout(() => {
    void checkForUpdate(options).catch(error => options.log(`[light-update] ${error}`))
  }, 4_000).unref()
}

async function checkForUpdate({ window, isQuitting, quitForHandoff, log }: LightUpdateOptions): Promise<void> {
  const ownTag = await readOwnTag()
  if (ownTag === null || isQuitting()) return
  const response = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { ...HEADERS, Accept: 'application/vnd.github+json' },
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Latest release check: HTTP ${response.status}`)
  const release = selectLightRelease(await response.json(), ownTag)
  if (!release || isQuitting()) return

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
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const stagedTag = STAGE_NAME.exec(entry.name)?.[1]
    if (entry.isDirectory() && stagedTag && stagedTag < release.tag) {
      await rm(path.join(root, entry.name), { recursive: true, force: true }).catch(error => log(`[light-update] ${error}`))
    }
  }
  const stage = await stageRelease(root, release, system32, log)
  if (isQuitting()) return
  const message = {
    type: 'question' as const,
    title: 'Hermes Light 更新',
    message: `发现新版本 ${release.tag}，已下载完成。现在重启并更新？`,
    buttons: ['重启并更新', '稍后'],
    defaultId: 1,
    cancelId: 1
  }
  const { response: choice } = !window.isDestroyed() && window.isVisible() && !window.isMinimized()
    ? await dialog.showMessageBox(window, message)
    : await dialog.showMessageBox(message)
  if (choice !== 0 || isQuitting()) return

  const script = path.join(stage, 'swap.ps1')
  await writeFile(script, SWAP_SCRIPT)
  if (isQuitting()) return
  const child = spawn(path.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', script, String(process.pid), installDir, release.tag
  ], { cwd: stage, detached: true, windowsHide: true, stdio: 'ignore' })
  child.on('error', error => log(`[light-update] updater launch failed: ${error}`))
  child.once('spawn', () => {
    child.unref()
    quitForHandoff()
  })
}
