import * as core from '@actions/core'
import * as fs from 'fs'
import {
  DeploymentRequest,
  DeploymentResponse,
  ArtifactResponse,
  ChangesResponse,
  DeploymentListResponse
} from '../types/index.js'
import { sleep } from '../utils/helpers.js'

export class UmbracoCloudAPI {
  private baseUrl: string
  private projectId: string
  private apiKey: string

  constructor(
    projectId: string,
    apiKey: string,
    baseUrl: string = 'https://api.cloud.umbraco.com'
  ) {
    this.baseUrl = baseUrl
    this.projectId = projectId
    this.apiKey = apiKey
  }

  private getHeaders(): Record<string, string> {
    return {
      'Umbraco-Cloud-Api-Key': this.apiKey,
      'Content-Type': 'application/json'
    }
  }

  private async retryWithLowercaseEnvironmentAlias<T>(
    originalRequest: () => Promise<T>,
    retryRequest: () => Promise<T>,
    targetEnvironmentAlias: string,
    operationName: string
  ): Promise<T> {
    try {
      return await originalRequest()
    } catch (error) {
      // Check if this is a case sensitivity issue with environment alias
      if (
        error instanceof Error &&
        (error.message.includes(
          'reason: No environments matches the provided alias'
        ) ||
          error.message.includes(
            'Unable to resolve target environment by Alias'
          )) &&
        targetEnvironmentAlias !== targetEnvironmentAlias.toLowerCase()
      ) {
        core.info(
          `Environment alias case sensitivity detected in ${operationName}. Retrying with lowercase: ${targetEnvironmentAlias} -> ${targetEnvironmentAlias.toLowerCase()}`
        )

        try {
          const result = await retryRequest()
          core.debug(`${operationName} succeeded with lowercase retry`)
          return result
        } catch (retryError) {
          core.error(
            `Error in ${operationName} (retry with lowercase): ${retryError}`
          )
          throw retryError
        }
      }

      throw error
    }
  }

  private async retryWithRateLimit<T>(
    request: () => Promise<T>,
    maxRetries: number = 3,
    baseDelay: number = 1000
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await request()
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('429 Too Many Requests') &&
          attempt < maxRetries
        ) {
          // Extract retry delay from error message if available
          let retryDelay = baseDelay * Math.pow(2, attempt - 1) // Exponential backoff

          // Try to parse the retry delay from the error message
          const match = error.message.match(/Try again in (\d+) seconds/)
          if (match) {
            retryDelay = parseInt(match[1], 10) * 1000 + 1000 // Add 1 second buffer
          }

          core.info(
            `Rate limit exceeded (attempt ${attempt}/${maxRetries}). Retrying in ${retryDelay}ms...`
          )
          await sleep(retryDelay)
          continue
        }
        throw error
      }
    }
    throw new Error(`Failed after ${maxRetries} attempts`)
  }

  async startDeployment(request: DeploymentRequest): Promise<string> {
    const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments`

    core.debug(`Starting deployment at ${url}`)
    core.debug(`Request body: ${JSON.stringify(request)}`)

    const originalRequest = async (): Promise<string> => {
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to start deployment: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const data = (await response.json()) as DeploymentResponse
      core.debug(`Deployment started successfully: ${JSON.stringify(data)}`)

      return data.deploymentId
    }

    const retryRequest = async (): Promise<string> => {
      const retryRequestData = {
        ...request,
        targetEnvironmentAlias: request.targetEnvironmentAlias.toLowerCase()
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(retryRequestData)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to start deployment (retry with lowercase): ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const data = (await response.json()) as DeploymentResponse
      core.debug(
        `Deployment started successfully (retry with lowercase): ${JSON.stringify(data)}`
      )

      return data.deploymentId
    }

    return this.retryWithLowercaseEnvironmentAlias(
      originalRequest,
      retryRequest,
      request.targetEnvironmentAlias,
      'startDeployment'
    )
  }

  async checkDeploymentStatus(
    deploymentId: string,
    targetEnvironmentAlias: string,
    timeoutSeconds: number = 1200
  ): Promise<DeploymentResponse> {
    const baseStatusUrl = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}`
    const startTime = Date.now()
    const timeoutMs = timeoutSeconds * 1000

    const statusesBeforeCompleted = ['Pending', 'InProgress', 'Queued']
    let run = 1
    let url = baseStatusUrl
    let data: DeploymentResponse | null = null

    core.debug(`Checking deployment status for: ${deploymentId}`)

    do {
      core.info(`[Run ${run}] Checking deployment status...`)

      try {
        const response = await this.retryWithRateLimit(async () => {
          const res = await fetch(url, {
            method: 'GET',
            headers: this.getHeaders()
          })

          if (!res.ok) {
            const errorText = await res.text()
            throw new Error(
              `Failed to check deployment status: ${res.status} ${res.statusText} - ${errorText}`
            )
          }

          return res
        })

        data = (await response.json()) as DeploymentResponse

        core.info(
          `[Run ${run}] Current deployment state: ${data.deploymentState}`
        )

        // Log deployment status messages if available
        if (
          data.deploymentStatusMessages &&
          data.deploymentStatusMessages.length > 0
        ) {
          data.deploymentStatusMessages.forEach((message) => {
            core.info(`[${message.timestampUtc}] ${message.message}`)
          })
        }

        // Check if deployment is complete
        if (!statusesBeforeCompleted.includes(data.deploymentState)) {
          core.info(`Deployment ${data.deploymentState}`)
          return data
        }

        // Update URL for next poll to only get new messages
        url = `${baseStatusUrl}?lastModifiedUtc=${encodeURIComponent(data.modifiedUtc)}`

        run++

        // Check timeout
        if (Date.now() - startTime > timeoutMs) {
          throw new Error(
            `Deployment status check timed out after ${timeoutSeconds} seconds. Current state: ${data.deploymentState}`
          )
        }

        // Wait before next poll
        await sleep(25000) // 25 seconds
      } catch (error) {
        core.error(`Error checking deployment status: ${error}`)
        throw error
      }
    } while (data && statusesBeforeCompleted.includes(data.deploymentState))

    // If we somehow get here without returning earlier, throw an error
    if (!data) {
      throw new Error('Failed to retrieve deployment status')
    }

    return data
  }

  async addDeploymentArtifact(
    filePath: string,
    description?: string,
    version?: string
  ): Promise<string> {
    const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/artifacts`

    // Validate file exists
    if (!filePath) {
      throw new Error('File path is required for artifact upload')
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`)
    }

    core.debug(`Uploading artifact: ${filePath}`)

    // Retry logic for artifact upload
    const maxRetries = parseInt(core.getInput('upload-retries') || '3', 10)
    const baseDelay = parseInt(
      core.getInput('upload-retry-delay') || '10000',
      10
    )
    const timeoutMs = parseInt(core.getInput('upload-timeout') || '60000', 10)

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        core.info(`Upload attempt ${attempt}/${maxRetries}...`)

        const formData = new FormData()

        // Read file and create a blob
        const fileBuffer = fs.readFileSync(filePath)
        const fileName = filePath.split(/[/\\]/).pop() || 'artifact.zip'
        const blob = new Blob([fileBuffer], { type: 'application/zip' })

        formData.append('file', blob, fileName)

        if (description) {
          formData.append('description', description)
        }

        if (version) {
          formData.append('version', version)
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Umbraco-Cloud-Api-Key': this.apiKey
              // Don't set Content-Type, let fetch set it for FormData
            },
            body: formData,
            signal: controller.signal
          })

          clearTimeout(timeoutId)

          if (!response.ok) {
            const errorText = await response.text()
            throw new Error(
              `Failed to upload artifact: ${response.status} ${response.statusText} - ${errorText}`
            )
          }

          const data = (await response.json()) as ArtifactResponse
          core.info(`Artifact uploaded successfully: ${data.artifactId}`)
          return data.artifactId
        } catch (error) {
          clearTimeout(timeoutId)
          throw error
        }
      } catch (error) {
        const isLastAttempt = attempt === maxRetries

        if (error instanceof Error && error.name === 'AbortError') {
          core.warning(
            `Upload attempt ${attempt} timed out after ${timeoutMs}ms`
          )
        } else {
          core.warning(`Upload attempt ${attempt} failed: ${error}`)
        }

        if (isLastAttempt) {
          throw error
        }

        // Wait before retry with exponential backoff
        const delay = baseDelay * Math.pow(2, attempt - 1)
        core.info(`Waiting ${delay}ms before retry...`)
        await sleep(delay)
      }
    }

    throw new Error('Upload failed after all retry attempts')
  }

  async getChangesById(
    deploymentId: string,
    targetEnvironmentAlias: string
  ): Promise<ChangesResponse> {
    const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}/diff?targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias)}`

    core.debug(
      `Getting changes for deploymentId: ${deploymentId}, targetEnvironmentAlias: ${targetEnvironmentAlias}`
    )

    const originalRequest = async (): Promise<ChangesResponse> => {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (response.status === 204) {
        return { changes: '' } // No changes
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to get changes: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const changes = await response.text()
      return { changes }
    }

    const retryRequest = async (): Promise<ChangesResponse> => {
      const retryUrl = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}/diff?targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias.toLowerCase())}`

      const response = await fetch(retryUrl, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (response.status === 204) {
        return { changes: '' } // No changes
      }

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to get changes (retry with lowercase): ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const changes = await response.text()
      return { changes }
    }

    try {
      return await this.retryWithLowercaseEnvironmentAlias(
        originalRequest,
        retryRequest,
        targetEnvironmentAlias,
        'getChangesById'
      )
    } catch (error) {
      core.error(`Error getting changes: ${error}`)
      throw error
    }
  }

  async applyPatch(
    changeId: string,
    targetEnvironmentAlias: string
  ): Promise<void> {
    const url = `${this.baseUrl}/v2/projects/${this.projectId}/changes/${changeId}/apply`

    core.debug(
      `Applying patch for change ID: ${changeId} to environment: ${targetEnvironmentAlias}`
    )

    try {
      const requestBody = {
        targetEnvironmentAlias
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(requestBody)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to apply patch: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      core.info(`Patch applied successfully`)
    } catch (error) {
      core.error(`Error applying patch: ${error}`)
      throw error
    }
  }

  async getDeployments(
    skip: number = 0,
    take: number = 100,
    includeNullDeployments: boolean = true,
    targetEnvironmentAlias?: string
  ): Promise<DeploymentListResponse> {
    let url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments?skip=${skip}&take=${take}&includeNullDeployments=${includeNullDeployments}`

    if (targetEnvironmentAlias) {
      url += `&targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias)}`
    }

    core.debug(`Getting deployments from: ${url}`)

    const request = async () => {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to get deployments: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      return response.json() as Promise<DeploymentListResponse>
    }

    try {
      return await this.retryWithRateLimit(request)
    } catch (error) {
      core.error(`Error getting deployments: ${error}`)
      throw error
    }
  }

  /**
   * Helper method to check if a deployment has changes (returns 200 vs 204)
   * without throwing errors, and handles environment alias case sensitivity
   */
  private async tryGetChangesWithResponse(
    deploymentId: string,
    targetEnvironmentAlias: string
  ): Promise<{ hasChanges: boolean; changes?: string }> {
    const originalRequest = async (): Promise<{
      hasChanges: boolean
      changes?: string
    }> => {
      const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}/diff?targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias)}`

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (response.status === 200) {
        const changes = await response.text()
        return { hasChanges: !!(changes && changes.trim().length > 0), changes }
      } else if (response.status === 204) {
        return { hasChanges: false }
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
    }

    const retryRequest = async (): Promise<{
      hasChanges: boolean
      changes?: string
    }> => {
      const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}/diff?targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias.toLowerCase())}`

      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (response.status === 200) {
        const changes = await response.text()
        return { hasChanges: !!(changes && changes.trim().length > 0), changes }
      } else if (response.status === 204) {
        return { hasChanges: false }
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
    }

    try {
      return await this.retryWithLowercaseEnvironmentAlias(
        originalRequest,
        retryRequest,
        targetEnvironmentAlias,
        'tryGetChangesWithResponse'
      )
    } catch (error) {
      core.debug(
        `Error checking changes for deployment ${deploymentId}: ${error}`
      )
      return { hasChanges: false }
    }
  }

  async getLatestCompletedDeployment(
    targetEnvironmentAlias: string
  ): Promise<string | null> {
    core.debug('Finding latest completed deployment with changes...')

    let skip = 0
    const take = 10
    const maxAttempts = 20

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      core.debug(`Checking deployments batch: skip=${skip}, take=${take}`)

      const deployments = await this.getDeployments(
        skip,
        take,
        false, // Only deployments with changes
        targetEnvironmentAlias
      )

      core.debug(
        `Found ${deployments.data.length} deployments in batch (total: ${deployments.totalItems})`
      )

      // Check each completed deployment to see if it has actual changes (200 response)
      for (const deployment of deployments.data) {
        if (deployment.state === 'Completed') {
          core.debug(
            `Checking deployment ${deployment.id} for actual changes...`
          )

          try {
            // Try to get changes for this deployment
            const changes = await this.tryGetChangesWithResponse(
              deployment.id,
              targetEnvironmentAlias
            )

            if (changes.hasChanges) {
              core.debug(
                `Found deployment ${deployment.id} with actual changes (200 response)`
              )
              return deployment.id
            } else {
              core.debug(
                `Deployment ${deployment.id} has no changes (204 response), checking next...`
              )
              continue // Try next deployment
            }
          } catch (error) {
            core.debug(
              `Error checking deployment ${deployment.id}: ${error}, checking next...`
            )
            continue // Try next deployment
          }
        }
      }

      // Check if we've reached the end
      if (
        deployments.data.length < take ||
        skip + take >= deployments.totalItems
      ) {
        break
      }

      skip += take
    }

    core.debug(
      'No completed deployments with changes found after checking all batches'
    )
    return null
  }

  /**
   * Get multiple latest completed deployments with changes for fallback scenarios
   * Returns up to maxResults deployment IDs that have actual changes
   */
  async getLatestCompletedDeployments(
    targetEnvironmentAlias: string,
    maxResults: number = 5
  ): Promise<string[]> {
    core.debug(
      `Finding up to ${maxResults} latest completed deployments with changes...`
    )

    let skip = 0
    const take = 10
    const maxAttempts = 20
    const foundDeployments: string[] = []

    for (
      let attempt = 0;
      attempt < maxAttempts && foundDeployments.length < maxResults;
      attempt++
    ) {
      core.debug(`Checking deployments batch: skip=${skip}, take=${take}`)

      const deployments = await this.getDeployments(
        skip,
        take,
        false, // Only deployments with changes
        targetEnvironmentAlias
      )

      core.debug(
        `Found ${deployments.data.length} deployments in batch (total: ${deployments.totalItems})`
      )

      // Check each completed deployment to see if it has actual changes (200 response)
      for (const deployment of deployments.data) {
        if (
          deployment.state === 'Completed' &&
          foundDeployments.length < maxResults
        ) {
          core.debug(
            `Checking deployment ${deployment.id} for actual changes...`
          )

          try {
            // Try to get changes for this deployment
            const changes = await this.tryGetChangesWithResponse(
              deployment.id,
              targetEnvironmentAlias
            )

            if (changes.hasChanges) {
              core.debug(
                `Found deployment ${deployment.id} with actual changes (200 response)`
              )
              foundDeployments.push(deployment.id)
            } else {
              core.debug(
                `Deployment ${deployment.id} has no changes (204 response), checking next...`
              )
              continue // Try next deployment
            }
          } catch (error) {
            core.debug(
              `Error checking deployment ${deployment.id}: ${error}, checking next...`
            )
            continue // Try next deployment
          }
        }
      }

      // Check if we've reached the end
      if (
        deployments.data.length < take ||
        skip + take >= deployments.totalItems
      ) {
        break
      }

      skip += take
    }

    core.debug(
      `Found ${foundDeployments.length} completed deployments with changes`
    )
    return foundDeployments
  }

  async getDeploymentErrorDetails(
    deploymentId: string,
    targetEnvironmentAlias: string
  ): Promise<string[]> {
    try {
      const deployment = await this.checkDeploymentStatus(
        deploymentId,
        targetEnvironmentAlias,
        10 // Short timeout just to get current status
      )

      const errorMessages: string[] = []

      if (deployment.deploymentStatusMessages) {
        deployment.deploymentStatusMessages
          .filter(
            (msg) =>
              msg.message.toLowerCase().includes('error') ||
              msg.message.toLowerCase().includes('failed') ||
              msg.message.toLowerCase().includes('exception')
          )
          .forEach((msg) => {
            errorMessages.push(`[${msg.timestampUtc}] ${msg.message}`)
          })
      }

      return errorMessages
    } catch (error) {
      core.debug(`Could not retrieve deployment error details: ${error}`)
      return []
    }
  }

  public getApiKey(): string {
    return this.apiKey
  }

  public getProjectId(): string {
    return this.projectId
  }
}
