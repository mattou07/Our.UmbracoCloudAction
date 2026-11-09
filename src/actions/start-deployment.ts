import * as core from '@actions/core'
import {
  ActionInputs,
  ActionOutputs,
  DeploymentRequest
} from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'

interface StartDeploymentOptions {
  /** How long to wait while Cloud reports another deployment in progress. */
  waitForRunningDeploymentMs?: number
  pollIntervalMs?: number
}

type StartDeploymentApi = {
  startDeployment(
    request: DeploymentRequest,
    options?: StartDeploymentOptions
  ): Promise<string>
}

/**
 * Starts a deployment. Polling for completion is done by handleCheckStatus.
 */
export async function handleStartDeployment(
  api: StartDeploymentApi,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs, ['artifactId', 'targetEnvironmentAlias'])

  const deploymentId = await api.startDeployment(
    {
      targetEnvironmentAlias: inputs.targetEnvironmentAlias,
      artifactId: inputs.artifactId!,
      commitMessage: inputs.commitMessage || 'Deployment from GitHub Actions',
      noBuildAndRestore: inputs.noBuildAndRestore || false,
      skipVersionCheck: inputs.skipVersionCheck || false
    },
    { waitForRunningDeploymentMs: (inputs.timeoutSeconds || 1200) * 1000 }
  )

  core.info(`Deployment started successfully with ID: ${deploymentId}`)
  core.setOutput('deploymentId', deploymentId)

  return { deploymentId }
}
