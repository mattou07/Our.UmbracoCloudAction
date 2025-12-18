import * as core from '@actions/core'
import { DeploymentResponse } from '../types/index.js'

/**
 * Polls deployment status until completion or timeout
 */
export async function pollDeploymentStatus(
  apiKey: string,
  projectId: string,
  deploymentId: string,
  maxDurationMs = 15 * 60 * 1000,
  intervalMs = 25000
): Promise<DeploymentResponse> {
  const start = Date.now()
  let lastModifiedUtc: string | undefined = undefined

  const timeoutMinutes = Math.round(maxDurationMs / 60000)
  core.info(
    `Polling deployment status (timeout: ${timeoutMinutes} minutes / ${maxDurationMs}ms, interval: ${intervalMs}ms)`
  )

  try {
    while (Date.now() - start < maxDurationMs) {
      const url =
        `https://api.cloud.umbraco.com/v2/projects/${projectId}/deployments/${deploymentId}` +
        (lastModifiedUtc
          ? `?lastModifiedUtc=${encodeURIComponent(lastModifiedUtc)}`
          : '')

      let response
      try {
        response = await fetch(url, {
          headers: {
            'Umbraco-Cloud-Api-Key':
              process.env.UMBRACO_CLOUD_API_KEY || apiKey,
            'Content-Type': 'application/json'
          }
        })
      } catch (err) {
        core.warning(`Network error while polling deployment status: ${err}`)
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        continue
      }

      if (response.status === 401) {
        core.warning(
          'Unauthorized: The API key may have expired or lost permissions. Will retry.'
        )
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        continue
      }
      if (response.status === 404) {
        core.warning(
          'Not Found: The project or deployment ID could not be found. Will retry.'
        )
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        continue
      }
      if (!response.ok) {
        core.warning(
          `Failed to get deployment status: ${response.status} ${response.statusText}. Will retry.`
        )
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
        continue
      }

      const data = (await response.json()) as DeploymentResponse
      const elapsedMs = Date.now() - start
      const elapsedMinutes = Math.round(elapsedMs / 60000)
      core.info(
        `Deployment status: ${data.deploymentState} (elapsed: ${elapsedMinutes}m, remaining: ${timeoutMinutes - elapsedMinutes}m)`
      )

      // Check for deployment status messages
      if (data.deploymentStatusMessages) {
        data.deploymentStatusMessages.forEach((msg) =>
          core.info(`[${msg.timestampUtc}] ${msg.message}`)
        )

        // Check for the specific "updating" marker blocking error
        const hasUpdatingMarkerError = data.deploymentStatusMessages.some(
          (msg) =>
            msg.message.includes(
              "The site can't be upgraded as it's blocked with the following markers: updating"
            ) ||
            msg.message.includes('CheckBlockingMarkers') ||
            msg.message.includes('blocked with the following markers: updating')
        )

        if (hasUpdatingMarkerError) {
          core.warning('⚠️  Deployment is blocked by leftover upgrade markers!')
          core.warning(
            'This error is caused by leftover upgrade markers interfering with the Deploy process.'
          )
          core.warning(
            'This might happen if your environment was restarted during an upgrade, or the upgrade process encountered issues.'
          )
          core.warning('')
          core.warning(
            'Resolution: Use KUDU to remove leftover marker files from site/locks folder'
          )
          core.warning(
            'For detailed steps, see: https://docs.umbraco.com/umbraco-cloud/optimize-and-maintain-your-site/monitor-and-troubleshoot/resolve-issues-quickly-and-efficiently/deployments/deployment-failed'
          )
          core.info('Continuing to poll for status changes...')
        }
      }

      if (
        data.deploymentState === 'Completed' ||
        data.deploymentState === 'Failed'
      ) {
        return data
      }

      lastModifiedUtc = data.modifiedUtc
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  } catch (unexpectedError) {
    const elapsedMs = Date.now() - start
    const elapsedMinutes = Math.round(elapsedMs / 60000)
    core.error(
      `Unexpected error during polling after ${elapsedMinutes} minutes: ${unexpectedError}`
    )
    throw unexpectedError
  }

  const elapsedMs = Date.now() - start
  const elapsedMinutes = Math.round(elapsedMs / 60000)
  core.error(
    `Polling loop exited after ${elapsedMinutes} minutes (${elapsedMs}ms). Max duration was ${maxDurationMs}ms.`
  )
  throw new Error(
    `Deployment did not complete within the expected time. Elapsed: ${elapsedMinutes} minutes, Timeout: ${timeoutMinutes} minutes.`
  )
}
