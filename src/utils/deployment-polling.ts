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
          'Umbraco-Cloud-Api-Key': process.env.UMBRACO_CLOUD_API_KEY || apiKey,
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
    core.info(`Deployment status: ${data.deploymentState}`)
    if (data.deploymentStatusMessages) {
      data.deploymentStatusMessages.forEach((msg) =>
        core.info(`[${msg.timestampUtc}] ${msg.message}`)
      )
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

  throw new Error('Deployment did not complete within the expected time.')
}
