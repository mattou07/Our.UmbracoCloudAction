import * as core from '@actions/core'
import { DeploymentResponse } from '../types/index.js'
import {
  IN_PROGRESS_STATES,
  UmbracoCloudAPI,
  UmbracoCloudApiError,
  formatDuration,
  isRetryableError
} from '../api/umbraco-cloud-api.js'
import { sleep } from './helpers.js'

/** States in which a deployment is still running. Anything else is terminal. */
export { IN_PROGRESS_STATES }

export const UPDATING_MARKER_PATTERNS = [
  "The site can't be upgraded as it's blocked with the following markers: updating",
  'CheckBlockingMarkers',
  'blocked with the following markers: updating'
]

export function hasUpdatingMarkerError(
  messages: DeploymentResponse['deploymentStatusMessages'] | undefined
): boolean {
  return (messages || []).some((msg) =>
    UPDATING_MARKER_PATTERNS.some((p) => msg.message.includes(p))
  )
}

/**
 * Polls deployment status until it reaches a terminal state or times out.
 *
 * - Transient failures (network errors, 429, 5xx) are logged and retried.
 * - Other client errors (401/403/404, ...) fail immediately: retrying a bad
 *   key or unknown deployment for the full timeout only wastes runner time.
 */
export async function pollDeploymentStatus(
  api: Pick<UmbracoCloudAPI, 'getDeploymentStatus'>,
  deploymentId: string,
  maxDurationMs = 20 * 60 * 1000,
  intervalMs = 25000
): Promise<DeploymentResponse> {
  const start = Date.now()
  const deadline = start + maxDurationMs
  let lastModifiedUtc: string | undefined
  let markerWarningShown = false
  let lastState: string | undefined
  // Cloud returns messages *at or after* lastModifiedUtc, so the boundary
  // message comes back on every poll. Track what we've printed.
  const printedMessages = new Set<string>()

  const timeoutMinutes = Math.round(maxDurationMs / 60000)
  core.info(
    `Polling deployment status (timeout: ${timeoutMinutes} minutes, interval: ${intervalMs}ms)`
  )

  while (Date.now() < deadline) {
    let data: DeploymentResponse | undefined
    try {
      data = await api.getDeploymentStatus(deploymentId, lastModifiedUtc)
    } catch (error) {
      if (!isRetryableError(error)) {
        if (error instanceof UmbracoCloudApiError && error.status === 401) {
          throw new Error(
            `Unauthorized while polling deployment ${deploymentId}: check the API key and its permissions. ${error.message}`
          )
        }
        throw error
      }
      core.warning(`Transient error while polling deployment status: ${error}`)
    }

    if (data) {
      lastState = data.deploymentState
      const elapsedMinutes = Math.round((Date.now() - start) / 60000)
      core.info(
        `Deployment status: ${data.deploymentState} (elapsed: ${elapsedMinutes}m, timeout: ${timeoutMinutes}m)`
      )

      for (const msg of data.deploymentStatusMessages || []) {
        const key = `${msg.timestampUtc}|${msg.message}`
        if (printedMessages.has(key)) continue
        printedMessages.add(key)
        core.info(`[${msg.timestampUtc}] ${msg.message}`)
      }

      if (
        !markerWarningShown &&
        hasUpdatingMarkerError(data.deploymentStatusMessages)
      ) {
        markerWarningShown = true
        core.warning(
          '⚠️  Deployment is blocked by leftover upgrade markers! Use KUDU to remove leftover marker files from the site/locks folder. See: https://docs.umbraco.com/umbraco-cloud/optimize-and-maintain-your-site/monitor-and-troubleshoot/resolve-issues-quickly-and-efficiently/deployments/deployment-failed'
        )
      }

      if (!IN_PROGRESS_STATES.includes(data.deploymentState)) {
        return data
      }

      lastModifiedUtc = data.modifiedUtc || lastModifiedUtc
    }

    // Never sleep past the deadline
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(intervalMs, remaining))
  }

  throw new Error(
    `Deployment ${deploymentId} did not complete within ${formatDuration(maxDurationMs)}. ` +
      "It may still be running in Umbraco Cloud — check the project's deployment history before re-running. " +
      `Last state: ${lastState ?? 'unknown'}. Elapsed: ${formatDuration(Date.now() - start)}.`
  )
}
