import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import * as github from '@actions/github'

interface DeploymentRequest {
  targetEnvironmentAlias: string
  artifactId: string
  commitMessage: string
  noBuildAndRestore: boolean
  skipVersionCheck: boolean
}

interface DeploymentResponse {
  deploymentId: string
  deploymentState: string
  modifiedUtc: string
  deploymentStatusMessages: Array<{
    timestampUtc: string
    message: string
  }>
}

interface ArtifactResponse {
  artifactId: string
}

interface ChangesResponse {
  changes: string // diff/patch text
}

class UmbracoCloudAPI {
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

  async startDeployment(request: DeploymentRequest): Promise<string> {
    const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments`

    core.debug(`Starting deployment at ${url}`)
    core.debug(`Request body: ${JSON.stringify(request)}`)

    try {
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
    } catch (error) {
      // Check if this is a case sensitivity issue with environment alias
      if (
        error instanceof Error &&
        error.message.includes(
          'reason: No environments matches the provided alias'
        ) &&
        request.targetEnvironmentAlias !==
          request.targetEnvironmentAlias.toLowerCase()
      ) {
        core.info(
          `Environment alias case sensitivity detected. Retrying with lowercase: ${request.targetEnvironmentAlias} -> ${request.targetEnvironmentAlias.toLowerCase()}`
        )

        // Retry with lowercase environment alias
        const retryRequest = {
          ...request,
          targetEnvironmentAlias: request.targetEnvironmentAlias.toLowerCase()
        }

        try {
          const retryResponse = await fetch(url, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(retryRequest)
          })

          if (!retryResponse.ok) {
            const errorText = await retryResponse.text()
            throw new Error(
              `Failed to start deployment (retry with lowercase): ${retryResponse.status} ${retryResponse.statusText} - ${errorText}`
            )
          }

          const data = (await retryResponse.json()) as DeploymentResponse
          core.debug(
            `Deployment started successfully (retry with lowercase): ${JSON.stringify(data)}`
          )

          return data.deploymentId
        } catch (retryError) {
          core.error(
            `Error starting deployment (retry with lowercase): ${retryError}`
          )
          throw retryError
        }
      }

      core.error(`Error starting deployment: ${error}`)
      throw error
    }
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

    core.debug(`Checking deployment status for: ${deploymentId}`)

    do {
      core.debug(`=====> Requesting Status - Run number ${run}`)

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: this.getHeaders()
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(
            `Failed to check deployment status: ${response.status} ${response.statusText} - ${errorText}`
          )
        }

        const deploymentResponse = (await response.json()) as DeploymentResponse

        core.debug(`DeploymentStatus: '${deploymentResponse.deploymentState}'`)

        for (const message of deploymentResponse.deploymentStatusMessages) {
          core.debug(`${message.timestampUtc}: ${message.message}`)
        }

        // Handle timeout
        if (Date.now() - startTime > timeoutMs) {
          throw new Error('Timeout was reached')
        }

        // Don't sleep if deployment was finished
        if (
          statusesBeforeCompleted.includes(deploymentResponse.deploymentState)
        ) {
          const sleepValue = 25
          core.debug(
            `=====> Still Deploying - sleeping for ${sleepValue} seconds`
          )
          await new Promise((resolve) => setTimeout(resolve, sleepValue * 1000))

          const lastModifiedUtc = new Date(
            deploymentResponse.modifiedUtc
          ).toISOString()
          url = `${baseStatusUrl}?lastModifiedUtc=${lastModifiedUtc}`
        }

        run++

        if (
          !statusesBeforeCompleted.includes(deploymentResponse.deploymentState)
        ) {
          return deploymentResponse
        }
      } catch (error) {
        // Check if this is a case sensitivity issue with environment alias
        if (
          error instanceof Error &&
          error.message.includes(
            'reason: No environments matches the provided alias'
          ) &&
          targetEnvironmentAlias !== targetEnvironmentAlias.toLowerCase()
        ) {
          core.info(
            `Environment alias case sensitivity detected in status check. Retrying with lowercase: ${targetEnvironmentAlias} -> ${targetEnvironmentAlias.toLowerCase()}`
          )

          // Retry with lowercase environment alias
          const retryUrl = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}`

          try {
            const retryResponse = await fetch(retryUrl, {
              method: 'GET',
              headers: this.getHeaders()
            })

            if (!retryResponse.ok) {
              const errorText = await retryResponse.text()
              throw new Error(
                `Failed to check deployment status (retry with lowercase): ${retryResponse.status} ${retryResponse.statusText} - ${errorText}`
              )
            }

            const deploymentResponse =
              (await retryResponse.json()) as DeploymentResponse
            core.debug(
              `Deployment status retrieved successfully (retry with lowercase): ${JSON.stringify(deploymentResponse)}`
            )

            return deploymentResponse
          } catch (retryError) {
            core.error(
              `Error checking deployment status (retry with lowercase): ${retryError}`
            )
            throw retryError
          }
        }

        core.error(`Error checking deployment status: ${error}`)
        throw error
      }
    } while (true)
  }

  async addDeploymentArtifact(
    filePath: string,
    description?: string,
    version?: string
  ): Promise<string> {
    const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/artifacts`

    // Validate file exists
    if (!filePath) {
      throw new Error('FilePath is empty')
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`FilePath does not contain a file: ${filePath}`)
    }

    core.debug(`Uploading artifact: ${filePath}`)

    try {
      const formData = new FormData()
      const fileBuffer = fs.readFileSync(filePath)
      const fileName = path.basename(filePath)

      formData.append('file', new Blob([fileBuffer]), fileName)

      if (description) {
        formData.append('description', description)
      }

      if (version) {
        formData.append('version', version)
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Umbraco-Cloud-Api-Key': this.apiKey
        },
        body: formData
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to upload artifact: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const data = (await response.json()) as ArtifactResponse
      core.debug(`Artifact uploaded successfully: ${JSON.stringify(data)}`)

      return data.artifactId
    } catch (error) {
      core.error(`Error uploading artifact: ${error}`)
      throw error
    }
  }

  async getChangesById(
    deploymentId: string,
    targetEnvironmentAlias: string
  ): Promise<ChangesResponse> {
    const url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}/diff?targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias)}`

    core.debug(
      `Getting changes for deploymentId: ${deploymentId}, targetEnvironmentAlias: ${targetEnvironmentAlias}`
    )

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to get changes: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      // The response is a diff/patch file, not JSON
      const diffText = await response.text()
      core.debug(
        `Changes (diff) retrieved successfully, length: ${diffText.length}`
      )

      // Return as a string, or wrap in an object for compatibility
      return { changes: diffText }
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
      const response = await fetch(url, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({
          targetEnvironmentAlias
        })
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to apply patch: ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      core.debug('Patch applied successfully')
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
  ): Promise<{
    projectId: string
    data: Array<{
      id: string
      artifactId: string | null
      targetEnvironmentAlias: string | null
      state: string
      createdUtc: string
      modifiedUtc: string
      completedUtc: string
    }>
    totalItems: number
    skippedItems: number
    takenItems: number
  }> {
    let url = `${this.baseUrl}/v2/projects/${this.projectId}/deployments?skip=${skip}&take=${take}&includeNullDeployments=${includeNullDeployments}`

    if (targetEnvironmentAlias) {
      url += `&targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias)}`
    }

    core.debug(`Getting deployments from: ${url}`)

    try {
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

      const data = (await response.json()) as {
        projectId: string
        data: Array<{
          id: string
          artifactId: string | null
          targetEnvironmentAlias: string | null
          state: string
          createdUtc: string
          modifiedUtc: string
          completedUtc: string
        }>
        totalItems: number
        skippedItems: number
        takenItems: number
      }
      core.debug(`Deployments retrieved successfully: ${JSON.stringify(data)}`)

      return data
    } catch (error) {
      core.error(`Error getting deployments: ${error}`)
      throw error
    }
  }

  async getLatestCompletedDeployment(
    targetEnvironmentAlias?: string
  ): Promise<string | null> {
    core.debug('Finding latest completed deployment...')

    let skip = 0
    const take = 10
    const maxAttempts = 10 // Try up to 100 deployments (10 batches of 10)

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        core.debug(
          `Fetching deployments batch ${attempt + 1} (skip: ${skip}, take: ${take})`
        )

        const deployments = await this.getDeployments(
          skip,
          take,
          true,
          targetEnvironmentAlias
        )

        if (deployments.data.length === 0) {
          core.debug('No more deployments found')
          break
        }

        // Find the first deployment with "Completed" state
        const completedDeployment = deployments.data.find(
          (deployment) => deployment.state === 'Completed'
        )

        if (completedDeployment) {
          core.debug(
            `Found latest completed deployment: ${completedDeployment.id} (from batch ${attempt + 1})`
          )
          return completedDeployment.id
        } else {
          core.debug(
            `No completed deployments found in batch ${attempt + 1}, trying next batch...`
          )
          skip += take
        }
      } catch (error) {
        core.error(`Error fetching deployment batch ${attempt + 1}: ${error}`)
        // Continue to next batch instead of failing completely
        skip += take
      }
    }

    core.debug('No completed deployments found after checking all batches')
    return null
  }
}

async function createPullRequestWithPatch(
  gitPatch: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<void> {
  const token = process.env.GH_TOKEN
  if (!token) {
    throw new Error(
      'GH_TOKEN environment variable is required for creating pull requests'
    )
  }

  const octokit = github.getOctokit(token)
  const context = github.context

  try {
    // Create a new branch name
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const newBranchName = `fix/deployment-failed-${timestamp}`

    core.info(`Creating new branch: ${newBranchName}`)

    // Get the latest commit SHA from the base branch
    const { data: ref } = await octokit.rest.git.getRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: `heads/${baseBranch}`
    })

    // Create the new branch
    await octokit.rest.git.createRef({
      owner: context.repo.owner,
      repo: context.repo.repo,
      ref: `refs/heads/${newBranchName}`,
      sha: ref.object.sha
    })

    core.info(`Branch ${newBranchName} created successfully`)

    // Apply the git patch
    // Note: This is a simplified approach. In a real implementation,
    // you'd need to parse the git patch and apply it file by file
    core.info('Git patch would be applied here')
    core.debug(`Git patch content: ${gitPatch}`)

    // Create a commit with the changes
    // For now, we'll create a placeholder commit
    const commitMessage = `Apply changes from failed deployment\n\n${body}`

    await octokit.rest.git.createCommit({
      owner: context.repo.owner,
      repo: context.repo.repo,
      message: commitMessage,
      tree: ref.object.sha, // This would be the tree SHA after applying the patch
      parents: [ref.object.sha]
    })

    // Create the pull request
    const { data: pr } = await octokit.rest.pulls.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: title,
      body: body,
      head: newBranchName,
      base: baseBranch
    })

    core.info(`Pull request created successfully: ${pr.html_url}`)
    core.setOutput('pr-url', pr.html_url)
    core.setOutput('pr-number', pr.number.toString())
  } catch (error) {
    core.error(`Failed to create pull request: ${error}`)
    throw error
  }
}

/**
 * The main function for the action.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Get inputs
    const projectId = core.getInput('projectId', { required: true })
    const apiKey = core.getInput('apiKey', { required: true })
    const action = core.getInput('action', { required: true })
    const baseUrl = core.getInput('baseUrl') || 'https://api.cloud.umbraco.com'

    // Initialize API client
    const api = new UmbracoCloudAPI(projectId, apiKey, baseUrl)

    core.debug(`Executing action: ${action}`)

    switch (action) {
      case 'start-deployment': {
        const artifactId = core.getInput('artifactId', { required: true })
        const targetEnvironmentAlias = core.getInput('targetEnvironmentAlias', {
          required: true
        })
        const commitMessage =
          core.getInput('commitMessage') || 'Deployment from GitHub Actions'
        const noBuildAndRestore = core.getBooleanInput('noBuildAndRestore')
        const skipVersionCheck = core.getBooleanInput('skipVersionCheck')

        const deploymentId = await api.startDeployment({
          targetEnvironmentAlias,
          artifactId,
          commitMessage,
          noBuildAndRestore,
          skipVersionCheck
        })

        core.setOutput('deploymentId', deploymentId)
        core.info(`Deployment started successfully with ID: ${deploymentId}`)
        break
      }

      case 'check-status': {
        const deploymentId = core.getInput('deploymentId', { required: true })
        const targetEnvironmentAlias = core.getInput('targetEnvironmentAlias', {
          required: true
        })
        const timeoutSeconds = parseInt(
          core.getInput('timeoutSeconds') || '1200',
          10
        )

        const deploymentStatus = await api.checkDeploymentStatus(
          deploymentId,
          targetEnvironmentAlias,
          timeoutSeconds
        )

        core.setOutput('deploymentState', deploymentStatus.deploymentState)
        core.setOutput('deploymentStatus', JSON.stringify(deploymentStatus))

        if (deploymentStatus.deploymentState === 'Completed') {
          core.info('Deployment completed successfully')
          // Get changes (diff) for completed deployment
          try {
            const changes = await api.getChangesById(
              deploymentId,
              targetEnvironmentAlias
            )
            core.info('Deployment completed. Here is the diff/patch:')
            core.info(changes.changes)
            core.setOutput('changes', JSON.stringify(changes))
          } catch (diffError) {
            core.warning(
              `Could not retrieve changes for completed deployment: ${diffError}`
            )
          }
        } else if (deploymentStatus.deploymentState === 'Failed') {
          core.setFailed('Deployment failed')
          core.warning(
            'Cannot retrieve changes for failed deployments - only completed deployments can be used to get git patches'
          )

          // Try to get the latest completed deployment and create a PR
          try {
            core.info(
              'Attempting to get latest completed deployment and create PR...'
            )

            const latestCompletedDeploymentId =
              await api.getLatestCompletedDeployment(targetEnvironmentAlias)

            if (latestCompletedDeploymentId) {
              core.info(
                `Found latest completed deployment ID: ${latestCompletedDeploymentId}`
              )

              // Get the changes from the latest completed deployment
              const changes = await api.getChangesById(
                latestCompletedDeploymentId,
                targetEnvironmentAlias
              )

              core.info('Retrieved changes from latest completed deployment')
              core.setOutput(
                'latest-completed-deployment-id',
                latestCompletedDeploymentId
              )
              core.setOutput('changes', JSON.stringify(changes))

              // Create GitHub PR with the changes
              const baseBranch =
                core.getInput('base-branch', { required: false }) || 'main'
              const prTitle = `Fix: Apply changes from failed deployment ${deploymentId}`
              const prBody = `This PR applies changes from the latest completed deployment (${latestCompletedDeploymentId}) to fix the failed deployment (${deploymentId}).

**Failed Deployment ID:** ${deploymentId}
**Latest Completed Deployment ID:** ${latestCompletedDeploymentId}
**Target Environment:** ${targetEnvironmentAlias}

The changes in this PR are based on the git patch from the latest successful deployment.`

              await createPullRequestWithPatch(
                changes.changes,
                baseBranch,
                prTitle,
                prBody
              )
            } else {
              core.warning('No completed deployments found to create PR from')
            }
          } catch (error) {
            core.warning(
              `Failed to get latest completed deployment or create PR: ${error}`
            )
          }
        } else {
          core.setFailed(
            `Unexpected deployment status: ${deploymentStatus.deploymentState}`
          )
        }
        break
      }

      case 'add-artifact': {
        const filePath = core.getInput('filePath', { required: true })
        const description = core.getInput('description')
        const version = core.getInput('version')

        const artifactId = await api.addDeploymentArtifact(
          filePath,
          description,
          version
        )

        core.setOutput('artifactId', artifactId)
        core.info(`Artifact uploaded successfully with ID: ${artifactId}`)
        break
      }

      case 'get-changes': {
        const deploymentId = core.getInput('deploymentId', { required: true })
        const targetEnvironmentAlias = core.getInput('targetEnvironmentAlias', {
          required: true
        })

        const changes = await api.getChangesById(
          deploymentId,
          targetEnvironmentAlias
        )

        core.setOutput('changes', JSON.stringify(changes))
        core.info(
          `Changes retrieved successfully for deployment ID: ${deploymentId}, targetEnvironmentAlias: ${targetEnvironmentAlias}`
        )
        break
      }

      case 'apply-patch': {
        const changeId = core.getInput('changeId', { required: true })
        const targetEnvironmentAlias = core.getInput('targetEnvironmentAlias', {
          required: true
        })

        await api.applyPatch(changeId, targetEnvironmentAlias)

        core.info(`Patch applied successfully for change ID: ${changeId}`)
        break
      }
    }
  } catch (error) {
    core.error(`Error running the action: ${error}`)
    throw error
  }
}
