import * as core from '@actions/core'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'
import { pollDeploymentStatus } from '../utils/deployment-polling.js'

export async function handleStartDeployment(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs as unknown as Record<string, unknown>, [
    'artifactId',
    'targetEnvironmentAlias'
  ])

  const deploymentId = await api.startDeployment({
    targetEnvironmentAlias: inputs.targetEnvironmentAlias!,
    artifactId: inputs.artifactId!,
    commitMessage: inputs.commitMessage || 'Deployment from GitHub Actions',
    noBuildAndRestore: inputs.noBuildAndRestore || false,
    skipVersionCheck: inputs.skipVersionCheck || false
  })

  core.info(`Deployment started successfully with ID: ${deploymentId}`)
  core.setOutput('deploymentId', deploymentId)

  // Poll deployment status until completion
  await pollDeploymentStatus(api.getApiKey(), api.getProjectId(), deploymentId)

  return {
    deploymentId
  }
}
