import { hermesApi } from '@/api/client'
import type { HermesStagedUpload } from '@/global'
import type { ComposerAttachment } from '@/store/composer'
import { $activeGatewayProfile } from '@/store/profile'
import { $connection } from '@/store/session'

import type { SubmissionDestination } from './submission-destination'

interface HttpUploadRoute {
  connectionId: string
  profile: null | string | undefined
}

/** Connection/profile of the destination session. Resolve before any read yields. */
function httpUploadRoute(destination: SubmissionDestination): HttpUploadRoute {
  const owner = destination.owner
  const connectionId = typeof owner === 'object' && owner ? owner.connectionId : $connection.get()?.connectionId

  const profile =
    typeof owner === 'object' && owner ? owner.targetProfile || owner.profile : owner || $activeGatewayProfile.get()

  return { connectionId: connectionId ?? 'local', profile }
}

function postChatImage(route: HttpUploadRoute, dataUrl: string, label: string) {
  return hermesApi<{ path: string; mime_type: string }>({
    method: 'POST',
    path: '/api/chat/image-upload',
    ...route,
    body: { data_url: dataUrl, filename: label }
  })
}

// Remote native Desktop sends attachment bytes over HTTP, never inside a
// gateway WebSocket frame: one huge frame queues every later RPC behind it,
// including the 5 s liveness ping, so a slow upload got the socket force-closed
// ("Hermes gateway connection closed"). The WS then only carries a small
// attach call naming the gateway-side copy (local change).

/** Put a local image on the gateway host; returns its gateway path for `image.attach`. */
export async function uploadRemoteImageOverHttp(
  destination: SubmissionDestination,
  path: string,
  label: string
): Promise<string> {
  const route = httpUploadRoute(destination)
  // Full-resolution file, not the chip preview (which may be a thumbnail).
  const reader = window.hermesDesktop?.readFileDataUrlForAttach ?? window.hermesDesktop?.readFileDataUrl
  const dataUrl = await reader?.(path)

  if (typeof dataUrl !== 'string' || !dataUrl) {
    throw new Error(`Could not read ${label}`)
  }

  return (await postChatImage(route, dataUrl, label)).path
}

/**
 * Stage a local file on the gateway host via the multipart upload route.
 * Electron main reads it by path (same checks as the attach read), so the
 * bytes never cross IPC as base64. Returns the staged-upload receipt for
 * `file.attach`, or only the gateway path when the backend issues none.
 */
export function stageRemoteFileOverHttp(
  destination: SubmissionDestination,
  path: string,
  label: string
): Promise<{ path: string; staged_upload?: HermesStagedUpload }> {
  return hermesApi<{ path: string; staged_upload?: HermesStagedUpload }>({
    method: 'POST',
    path: '/api/chat/file-upload',
    ...httpUploadRoute(destination),
    upload: { path, filename: label }
  })
}

/**
 * Upload an image attachment over HTTP for a server-owned composer queue.
 * Pin HTTP to the same owner before the native byte read yields. Images are
 * immutable admission payloads, never legacy agent.pending_images.
 */
export async function uploadServerOwnedImage(
  attachment: ComposerAttachment,
  destination: SubmissionDestination,
  path: string,
  label: string,
  sessionId: string
): Promise<ComposerAttachment> {
  const route = httpUploadRoute(destination)

  const dataUrl = attachment.previewUrl?.includes(';base64,')
    ? attachment.previewUrl
    : await window.hermesDesktop?.readFileDataUrl(path)

  if (!dataUrl) {
    throw new Error(`Could not read ${label}`)
  }

  const result = await postChatImage(route, dataUrl as string, label)

  return {
    ...attachment,
    path: result.path,
    mime: result.mime_type,
    attachedSessionId: sessionId,
    uploadState: undefined
  }
}
