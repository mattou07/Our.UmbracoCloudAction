import * as core from '@actions/core'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'

export async function handleGetChanges(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs as unknown as Record<string, unknown>, [
    'deploymentId',
    'targetEnvironmentAlias'
  ])

  const changes = await api.getChangesById(
    inputs.deploymentId!,
    inputs.targetEnvironmentAlias!
  )

  core.info(
    `Changes retrieved successfully for deployment ID: ${inputs.deploymentId}, targetEnvironmentAlias: ${inputs.targetEnvironmentAlias}`
  )

  core.setOutput('changes', JSON.stringify(changes))

  return {
    changes: JSON.stringify(changes)
  }
}
