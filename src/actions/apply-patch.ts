import * as core from '@actions/core'
import { UmbracoCloudAPI } from '../api/umbraco-cloud-api.js'
import { ActionInputs, ActionOutputs } from '../types/index.js'
import { validateRequiredInputs } from '../utils/helpers.js'

export async function handleApplyPatch(
  api: UmbracoCloudAPI,
  inputs: ActionInputs
): Promise<ActionOutputs> {
  validateRequiredInputs(inputs as unknown as Record<string, unknown>, [
    'changeId',
    'targetEnvironmentAlias'
  ])

  await api.applyPatch(inputs.changeId!, inputs.targetEnvironmentAlias!)

  core.info(`Patch applied successfully for change ID: ${inputs.changeId}`)

  return {}
}
