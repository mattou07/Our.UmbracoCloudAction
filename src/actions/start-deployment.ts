import * as core from '@actions/core'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'

/**
 * Starts a deployment. Polling for completion is done by handleCheckStatus.
 */
export async function handleStartDeployment(
  api: Pick<UmbracoCloudAPI, 'startDeployment'>,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs, ['artifactId', 'targetEnvironmentAlias'])

  const deploymentId = await api.startDeployment({
    targetEnvironmentAlias: inputs.targetEnvironmentAlias,
    artifactId: inputs.artifactId!,
    commitMessage: inputs.commitMessage || 'Deployment from GitHub Actions',
    noBuildAndRestore: inputs.noBuildAndRestore || false,
    skipVersionCheck: inputs.skipVersionCheck || false
  })

  core.info(`Deployment started successfully with ID: ${deploymentId}`)
  core.setOutput('deploymentId', deploymentId)

  return { deploymentId }
}
