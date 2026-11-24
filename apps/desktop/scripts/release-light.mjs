#!/usr/bin/env node
// Build the Windows portable Hermes Light and publish it as a GitHub release
// that installed copies pick up through electron/light-self-update.ts.
//
//   node scripts/release-light.mjs [--notes "text"] [--skip-build]
//
// Requires: clean git tree, `gh` logged in with repo scope, Windows tar.exe.
// Steps: push HEAD to the release branch, pack the light variant, stamp
// resources/light-release.json, zip as HermesLight/..., create the release.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = '1VeniVediVeci1/hermes-light-veni'
const BRANCH = 'light'
const ASSET = 'HermesLight-win-x64.zip'
const REMOTE_URL = `https://github.com/${REPO}.git`

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseDir = path.join(desktopDir, 'release')
const unpackedDir = path.join(releaseDir, 'win-unpacked')

const args = process.argv.slice(2)
const notesIndex = args.indexOf('--notes')
const notes = notesIndex >= 0 ? args[notesIndex + 1] : ''
const skipBuild = args.includes('--skip-build')

const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: desktopDir, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts }).trim()

const runLoud = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: desktopDir, stdio: 'inherit', ...opts })

if (process.platform !== 'win32') throw new Error('release-light builds the Windows portable package; run it on Windows')

if (run('git', ['status', '--porcelain'])) {
  throw new Error('Working tree is not clean; commit the release changes first')
}

const sha = run('git', ['rev-parse', 'HEAD'])
const now = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
const tag = `light-${now}`

console.log(`[release-light] ${tag} @ ${sha}`)
// Authenticate the push with the gh login instead of an interactive helper.
runLoud('git', [
  '-c',
  'credential.helper=',
  '-c',
  'credential.helper=!gh auth git-credential',
  'push',
  REMOTE_URL,
  `HEAD:refs/heads/${BRANCH}`
])

if (!skipBuild) {
  fs.rmSync(unpackedDir, { recursive: true, force: true })
  // shell: true resolves pnpm whether it is installed as pnpm.cmd or pnpm.exe.
  runLoud('pnpm', ['run', 'pack'], {
    shell: true,
    env: { ...process.env, HERMES_DESKTOP_VARIANT: 'light', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  })
}

if (!fs.existsSync(path.join(unpackedDir, 'Hermes Light.exe'))) {
  throw new Error(`Packed app not found in ${unpackedDir}`)
}

fs.writeFileSync(
  path.join(unpackedDir, 'resources', 'light-release.json'),
  `${JSON.stringify({ tag, repo: REPO, asset: ASSET }, null, 2)}\n`
)

const zipPath = path.join(releaseDir, ASSET)
fs.rmSync(zipPath, { force: true })
// The zip root must be HermesLight/; Windows bsdtar has no -s rename, so
// rename the folder around the zip.
const zipRoot = path.join(releaseDir, 'HermesLight')
fs.rmSync(zipRoot, { recursive: true, force: true })
fs.renameSync(unpackedDir, zipRoot)

try {
  runLoud(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), [
    '-a',
    '-c',
    '-f',
    zipPath,
    '-C',
    releaseDir,
    'HermesLight'
  ])
} finally {
  fs.renameSync(zipRoot, unpackedDir)
}

runLoud('gh', [
  'release',
  'create',
  tag,
  zipPath,
  '--repo',
  REPO,
  '--target',
  sha,
  '--title',
  `Hermes Light ${tag.slice('light-'.length)}`,
  '--notes',
  notes || `Portable Windows build from ${sha.slice(0, 12)}.`,
  '--latest'
])

console.log(`[release-light] published ${tag}: https://github.com/${REPO}/releases/tag/${tag}`)
