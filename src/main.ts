import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'
import * as path from 'path'
import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'

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

    core.debug(`Checking deployment status for: ${deploymentId}`)

    do {
      core.debug(`=====> Requesting Status - Run number ${run}`)

      const originalRequest = async (): Promise<DeploymentResponse> => {
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

        // Continue the loop
        throw new Error('Continue polling')
      }

      const retryRequest = async (): Promise<DeploymentResponse> => {
        const retryUrl = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}`

        const response = await fetch(retryUrl, {
          method: 'GET',
          headers: this.getHeaders()
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(
            `Failed to check deployment status (retry with lowercase): ${response.status} ${response.statusText} - ${errorText}`
          )
        }

        const deploymentResponse = (await response.json()) as DeploymentResponse
        core.debug(
          `Deployment status retrieved successfully (retry with lowercase): ${JSON.stringify(deploymentResponse)}`
        )

        return deploymentResponse
      }

      try {
        const deploymentResponse =
          await this.retryWithLowercaseEnvironmentAlias(
            originalRequest,
            retryRequest,
            targetEnvironmentAlias,
            'checkDeploymentStatus'
          )

        return deploymentResponse
      } catch (error) {
        if (error instanceof Error && error.message === 'Continue polling') {
          continue
        }
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

    // Validate that the zip contains a git repository
    core.info('Validating zip file contains git repository...')
    try {
      // Extract zip to current directory to check for .git folder
      await exec.exec('unzip', ['-q', filePath])

      // Check if this is a valid git repository using git command
      await exec.exec('git', ['rev-parse', '--git-dir'])

      core.info('Git repository validation successful')
    } catch (error) {
      if (error instanceof Error && error.message.includes('git repository')) {
        core.setFailed(error.message)
        throw error
      }
      core.setFailed(`Failed to validate git repository in zip: ${error}`)
      throw error
    }

    core.debug(`Uploading artifact: ${filePath}`)

    // Retry logic for artifact upload
    const maxRetries = parseInt(core.getInput('upload-retries') || '3', 10)
    const baseDelay = parseInt(
      core.getInput('upload-retry-delay') || '30000',
      10
    ) // 30 seconds default
    const timeoutMs = parseInt(core.getInput('upload-timeout') || '60000', 10) // 1 minute default

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
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

        // Create AbortController for timeout
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: {
              'Umbraco-Cloud-Api-Key': this.apiKey
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
          core.debug(`Artifact uploaded successfully: ${JSON.stringify(data)}`)

          return data.artifactId
        } catch (fetchError) {
          clearTimeout(timeoutId)
          throw fetchError
        }
      } catch (error) {
        const isLastAttempt = attempt === maxRetries
        const isTimeoutError =
          error instanceof Error &&
          (error.name === 'AbortError' ||
            error.message.includes('timeout') ||
            error.message.includes('Headers Timeout'))

        if (isLastAttempt) {
          core.error(
            `Error uploading artifact after ${maxRetries} attempts: ${error}`
          )
          throw error
        }

        if (isTimeoutError) {
          const delay = baseDelay * attempt
          core.warning(
            `Upload attempt ${attempt} failed due to timeout. Retrying in ${delay}ms...`
          )
          await new Promise((resolve) => setTimeout(resolve, delay))
        } else {
          // For non-timeout errors, don't retry
          core.error(`Error uploading artifact: ${error}`)
          throw error
        }
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
    }

    const retryRequest = async (): Promise<ChangesResponse> => {
      const retryUrl = `${this.baseUrl}/v2/projects/${this.projectId}/deployments/${deploymentId}/diff?targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias.toLowerCase())}`

      const response = await fetch(retryUrl, {
        method: 'GET',
        headers: this.getHeaders()
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(
          `Failed to get changes (retry with lowercase): ${response.status} ${response.statusText} - ${errorText}`
        )
      }

      const diffText = await response.text()
      core.debug(
        `Changes (diff) retrieved successfully (retry with lowercase), length: ${diffText.length}`
      )

      return { changes: diffText }
    }

    return this.retryWithLowercaseEnvironmentAlias(
      originalRequest,
      retryRequest,
      targetEnvironmentAlias,
      'getChangesById'
    )
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
      const err = error as Error
      core.setFailed(`Failed to apply patch: ${err.message}`)
      throw err
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
  body: string,
  latestCompletedDeploymentId: string
): Promise<void> {
  try {
    // Create a new branch name using the format: umbcloud/{deploymentId}
    let newBranchName = `umbcloud/${latestCompletedDeploymentId}`
    let guidConflictOccurred = false
    core.info(`Creating new branch: ${newBranchName}`)

    // Initialize Octokit
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
    if (!token) {
      throw new Error(
        'GitHub token not found. If using a custom token, please ensure GH_TOKEN environment variable is set.'
      )
    }

    const octokit = new Octokit({
      auth: token
    })

    const { owner, repo } = github.context.repo

    // Get the latest commit SHA from the current workflow branch
    const { data: baseBranchData } = await octokit.repos.getBranch({
      owner,
      repo,
      branch: baseBranch
    })
    const baseSha = baseBranchData.commit.sha
    core.info(`Base branch SHA: ${baseSha}`)

    // Create the new branch using Octokit
    try {
      await octokit.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${newBranchName}`,
        sha: baseSha
      })
      core.info(`Branch ${newBranchName} created successfully`)
    } catch (error) {
      // Branch might already exist due to GUID conflict, try with a random suffix
      if (
        error instanceof Error &&
        error.message.includes('Reference already exists')
      ) {
        const randomSuffix = Math.random().toString(36).substring(2, 8)
        const newBranchNameWithSuffix = `${newBranchName}-${randomSuffix}`
        core.warning(
          `GUID conflict detected! Attempting to create branch with suffix: ${newBranchNameWithSuffix}`
        )

        await octokit.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${newBranchNameWithSuffix}`,
          sha: baseSha
        })
        core.info(`Branch ${newBranchNameWithSuffix} created successfully`)

        // Update the branch name for the rest of the function
        newBranchName = newBranchNameWithSuffix
        guidConflictOccurred = true
      } else {
        throw error
      }
    }

    // Create a temporary patch file and apply it using git
    const patchFileName = `git-patch-${latestCompletedDeploymentId}.diff`
    const patchFilePath = path.join(process.cwd(), patchFileName)

    try {
      // Reset and clean the working directory before applying the patch
      core.info(
        'Resetting working directory to clean state before applying patch...'
      )
      await exec.exec('git', ['reset', '--hard', 'HEAD'])
      await exec.exec('git', ['clean', '-fd'])
      core.info('Working directory reset complete')

      // Write the patch content to a temporary file
      fs.writeFileSync(patchFilePath, gitPatch)
      core.info(`Created patch file: ${patchFilePath}`)

      // Apply the patch using git apply with theirs option to always accept patch content
      const gitApplyExitCode = await exec.exec('git', [
        'apply',
        '--index',
        '--3way',
        '--theirs',
        patchFilePath
      ])

      if (gitApplyExitCode === 0) {
        core.info(
          'Patch applied successfully using git apply with theirs option'
        )
      } else {
        core.warning(
          `Initial patch application failed with exit code: ${gitApplyExitCode}`
        )

        // Check for any rejected hunks (.rej files) and try to apply them
        const rejFiles = fs
          .readdirSync(process.cwd())
          .filter((file) => file.endsWith('.rej'))
        if (rejFiles.length > 0) {
          core.warning(
            `Some parts of the patch could not be applied. Rejected files: ${rejFiles.join(', ')}`
          )

          // Try to apply rejected hunks manually
          for (const rejFile of rejFiles) {
            try {
              core.info(`Attempting to apply rejected hunks from ${rejFile}...`)
              await exec.exec('git', ['apply', '--reject', rejFile])
              core.info(`Successfully reapplied rejected hunks from ${rejFile}`)
            } catch (rejError) {
              core.warning(
                `Could not apply rejected hunks from ${rejFile}: ${rejError}`
              )
            }
          }
        }

        // If we still have issues, throw an error
        if (gitApplyExitCode !== 0) {
          throw new Error(
            `Git apply failed with exit code: ${gitApplyExitCode}`
          )
        }
      }
    } catch (applyError) {
      core.warning(`Initial patch application failed: ${applyError}`)

      // Check for any rejected hunks (.rej files) and try to apply them
      const rejFiles = fs
        .readdirSync(process.cwd())
        .filter((file) => file.endsWith('.rej'))
      if (rejFiles.length > 0) {
        core.warning(
          `Some parts of the patch could not be applied. Rejected files: ${rejFiles.join(', ')}`
        )

        // Try to apply rejected hunks manually
        for (const rejFile of rejFiles) {
          try {
            core.info(`Attempting to apply rejected hunks from ${rejFile}...`)
            await exec.exec('git', ['apply', '--reject', rejFile])
            core.info(`Successfully reapplied rejected hunks from ${rejFile}`)
          } catch (rejError) {
            core.warning(
              `Could not apply rejected hunks from ${rejFile}: ${rejError}`
            )
          }
        }
      }

      // Re-throw the original error if we still can't apply the patch
      throw applyError
    } finally {
      // Clean up the temporary patch file
      if (fs.existsSync(patchFilePath)) {
        fs.unlinkSync(patchFilePath)
        core.info(`Cleaned up patch file: ${patchFilePath}`)
      }
    }

    // Get the current status to see what files were changed
    await exec.exec('git', ['status', '--porcelain'], {
      listeners: {
        stdout: (data: Buffer) => {
          const output = data.toString()
          core.info(`Git status: ${output}`)
        }
      }
    })

    // Stage all changes
    await exec.exec('git', ['add', '.'])
    core.info('All changes staged')

    // Configure git user for the commit
    await exec.exec('git', ['config', 'user.name', 'github-actions[bot]'])
    await exec.exec('git', [
      'config',
      'user.email',
      '41898282+github-actions[bot]@users.noreply.github.com'
    ])
    core.info('Git user configured for commit')

    // Commit the changes using git
    await exec.exec('git', [
      'commit',
      '-m',
      `Apply changes from failed deployment\n\n${body}`
    ])
    core.info('Changes committed successfully')

    // Get the commit SHA of the new commit
    let commitSha = ''
    await exec.exec('git', ['rev-parse', 'HEAD'], {
      listeners: {
        stdout: (data: Buffer) => {
          commitSha = data.toString().trim()
        }
      }
    })

    // Update the branch reference to point to the new commit
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${newBranchName}`,
      sha: commitSha
    })

    core.info(`Branch updated to commit: ${commitSha}`)

    // Create pull request using Octokit
    try {
      let prBodyWithConflictInfo = body
      if (guidConflictOccurred) {
        prBodyWithConflictInfo = `${body}

**Note:** A GUID conflict occurred during branch creation. The branch name was modified with a random suffix to ensure uniqueness.`
      }

      const { data: pullRequest } = await octokit.pulls.create({
        owner,
        repo,
        title,
        body: prBodyWithConflictInfo,
        head: newBranchName,
        base: baseBranch
      })

      core.info(`Pull request created successfully: ${pullRequest.html_url}`)
      core.setOutput('pull-request-number', pullRequest.number.toString())
      core.setOutput('pull-request-url', pullRequest.html_url)
    } catch (prError) {
      core.error(`Failed to create pull request: ${prError}`)
      throw prError
    }
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
              const baseBranch = github.context.ref.replace('refs/heads/', '')
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
                prBody,
                latestCompletedDeploymentId
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
