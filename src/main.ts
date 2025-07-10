import * as core from '@actions/core'
import { UmbracoCloudAPI } from './api/umbraco-cloud-api.js'
import { handleStartDeployment } from './actions/start-deployment.js'
import { handleCheckStatus } from './actions/check-status.js'
import { handleAddArtifact } from './actions/add-artifact.js'
import { handleGetChanges } from './actions/get-changes.js'
import { handleApplyPatch } from './actions/apply-patch.js'
import { ActionInputs } from './types/index.js'

/**
 * Gets all input values for the action
 */
function getActionInputs(): ActionInputs {
  return {
    projectId: core.getInput('projectId', { required: true }),
    apiKey: core.getInput('apiKey', { required: true }),
    action: core.getInput('action', { required: true }),
    baseUrl: core.getInput('baseUrl') || 'https://api.cloud.umbraco.com',
    artifactId: core.getInput('artifactId'),
    targetEnvironmentAlias: core.getInput('targetEnvironmentAlias'),
    commitMessage:
      core.getInput('commitMessage') || 'Deployment from GitHub Actions',
    noBuildAndRestore: core.getBooleanInput('noBuildAndRestore'),
    skipVersionCheck: core.getBooleanInput('skipVersionCheck'),
    deploymentId: core.getInput('deploymentId'),
    timeoutSeconds: parseInt(core.getInput('timeoutSeconds') || '1200', 10),
    filePath: core.getInput('filePath'),
    description: core.getInput('description'),
    version: core.getInput('version'),
    changeId: core.getInput('changeId'),
    baseBranch: core.getInput('baseBranch'),
    uploadRetries: parseInt(core.getInput('upload-retries') || '3', 10),
    uploadRetryDelay: parseInt(
      core.getInput('upload-retry-delay') || '10000',
      10
    ),
    uploadTimeout: parseInt(core.getInput('upload-timeout') || '60000', 10),
    nugetSourceName: core.getInput('nuget-source-name'),
    nugetSourceUrl: core.getInput('nuget-source-url'),
    nugetSourceUsername: core.getInput('nuget-source-username'),
    nugetSourcePassword: core.getInput('nuget-source-password')
  }
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const inputs = getActionInputs()

    // Initialize API client
    const api = new UmbracoCloudAPI(
      inputs.projectId,
      inputs.apiKey,
      inputs.baseUrl
    )

    core.debug(`Executing action: ${inputs.action}`)

    switch (inputs.action) {
      case 'start-deployment':
        await handleStartDeployment(api, inputs)
        break

      case 'check-status':
        await handleCheckStatus(api, inputs)
        break

      case 'add-artifact':
        await handleAddArtifact(api, inputs)
        break

      case 'get-changes':
        await handleGetChanges(api, inputs)
        break

      case 'apply-patch':
        await handleApplyPatch(api, inputs)
        break

      default:
        core.setFailed(
          `Unknown action: ${inputs.action}. Supported actions: start-deployment, check-status, add-artifact, get-changes, apply-patch`
        )
    }
  } catch (error) {
    core.error(`Error running the action: ${error}`)
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed('An unknown error occurred')
    }
  }
}
