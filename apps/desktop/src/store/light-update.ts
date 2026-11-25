import type { DesktopUpdateStatus } from '@/global'
import { translateNow } from '@/i18n'
import { notify } from '@/store/notifications'

// Keep the Light card independent of the backend's update toast. Closing one
// offer hides its subsequent progress and failure in this window, not the job.
const TOAST_ID = 'light-portable-update'
let dismissedTag: string | undefined

export function lightUpdatePhase(stage: 'prepare' | 'fetch' | 'restart'): string {
  return translateNow(`updates.stages.${stage}`)
}

export function showLightUpdateOffer(status: DesktopUpdateStatus, tag: string, apply: () => void): void {
  if (tag === dismissedTag) return
  const progress = status.lightProgress
  const failed = Boolean(status.message)
  const version = translateNow('shell.statusbar.releaseAvailable', tag)
  notify({
    action: progress ? undefined : {
      keepOpen: true,
      label: failed ? translateNow('common.retry') : translateNow('notifications.lightDownloadAndUpdate'),
      onClick: apply
    },
    durationMs: 0,
    icon: failed ? undefined : 'gift',
    id: TOAST_ID,
    kind: failed ? 'error' : 'info',
    message: status.message ? `${version} ${translateNow('notifications.lightUpdateFailed', status.message)}` : version,
    meta: progress?.stage === 'fetch' ? `${progress.percent}% · ${(progress.bytesPerSecond / 1_000_000).toFixed(1)} MB/s` : undefined,
    onDismiss: () => { dismissedTag = tag },
    persistent: true,
    placement: 'bottom-right',
    progress: progress?.stage === 'fetch' ? progress.percent : progress ? null : undefined,
    title: progress ? lightUpdatePhase(progress.stage) : failed ? translateNow('updates.errorTitle') : translateNow('notifications.lightUpdateAvailable')
  })
}
