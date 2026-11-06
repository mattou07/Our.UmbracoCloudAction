import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import {
  DeploymentRequest,
  DeploymentResponse,
  ArtifactResponse,
  ChangesResponse,
  DeploymentListResponse
} from '../types/index.js'
import { sleep } from '../utils/helpers.js'
import { fetchWithApiLogging } from '../utils/api-logging.js'
import { redactSignedUrls } from '../utils/redact.js'

export const DEFAULT_BASE_URL = 'https://api.cloud.umbraco.com'

/**
 * Error thrown for non-2xx responses from the Umbraco Cloud API.
 * Carries the HTTP status so callers can decide whether to retry.
 */
export class UmbracoCloudApiError extends Error {
  readonly status: number
  readonly body: string
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    status: number,
    body: string,
    retryAfterSeconds?: number
  ) {
    super(message)
    this.name = 'UmbracoCloudApiError'
    this.status = status
    this.body = body
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface UmbracoCloudApiOptions {
  baseUrl?: string
  uploadRetries?: number
  uploadRetryDelayMs?: number
  uploadTimeoutMs?: number
  /** Base delay for 429 back-off when the API gives no Retry-After hint */
  rateLimitBaseDelayMs?: number
}

/**
 * Status messages worth surfacing when a deployment fails. Cloud reports some
 * failures without the word "error", e.g. "Cannot apply update because the
 * following packages would be downgraded: ...".
 */
const ERROR_MESSAGE_PATTERN =
  /error|fail|exception|cannot|could not|unable to|downgrad/i

const ENVIRONMENT_ALIAS_ERRORS = [
  'No environments matches the provided alias',
  'Unable to resolve target environment by Alias'
]

/** Retry on throttling, server errors and network failures — never on other 4xx. */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof UmbracoCloudApiError) {
    return error.status === 429 || error.status >= 500
  }
  // fetch() rejects with TypeError on network failures; AbortError on timeout
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TypeError')
  )
}

/** Honour a server-provided Retry-After hint (plus 1s buffer) when present. */
function retryDelayFor(error: unknown, fallbackMs: number): number {
  if (
    error instanceof UmbracoCloudApiError &&
    error.retryAfterSeconds !== undefined
  ) {
    return error.retryAfterSeconds * 1000 + 1000
  }
  return fallbackMs
}

function parseRetryAfter(response: Response, body: string): number | undefined {
  const header = response.headers?.get?.('retry-after')
  if (header && /^\d+$/.test(header.trim())) {
    return parseInt(header, 10)
  }
  const match = body.match(/Try again in (\d+) seconds/i)
  return match ? parseInt(match[1], 10) : undefined
}

export class UmbracoCloudAPI {
  private readonly baseUrl: string
  private readonly projectId: string
  private readonly apiKey: string
  private readonly uploadRetries: number
  private readonly uploadRetryDelayMs: number
  private readonly uploadTimeoutMs: number
  private readonly rateLimitBaseDelayMs: number

  constructor(
    projectId: string,
    apiKey: string,
    options: UmbracoCloudApiOptions = {}
  ) {
    this.projectId = projectId
    this.apiKey = apiKey
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.uploadRetries = Math.max(1, options.uploadRetries ?? 3)
    this.uploadRetryDelayMs = Math.max(0, options.uploadRetryDelayMs ?? 10000)
    this.uploadTimeoutMs = Math.max(1, options.uploadTimeoutMs ?? 60000)
    this.rateLimitBaseDelayMs = options.rateLimitBaseDelayMs ?? 1000
  }

  private get projectUrl(): string {
    return `${this.baseUrl}/v2/projects/${encodeURIComponent(this.projectId)}`
  }

  private getHeaders(): Record<string, string> {
    return {
      'Umbraco-Cloud-Api-Key': this.apiKey,
      'Content-Type': 'application/json'
    }
  }

  /**
   * Performs a request and throws UmbracoCloudApiError for non-2xx responses.
   */
  private async send(
    url: string,
    init: RequestInit,
    operation: string,
    errorPrefix: string,
    metadata?: Record<string, unknown>
  ): Promise<Response> {
    const response = await fetchWithApiLogging(url, init, {
      operation,
      metadata
    })

    if (!response.ok) {
      const body = await response.text()
      throw new UmbracoCloudApiError(
        `${errorPrefix}: ${response.status} ${response.statusText} - ${body}`,
        response.status,
        body,
        parseRetryAfter(response, body)
      )
    }

    return response
  }

  private async retryWithLowercaseEnvironmentAlias<T>(
    request: (alias: string) => Promise<T>,
    targetEnvironmentAlias: string,
    operationName: string
  ): Promise<T> {
    try {
      return await request(targetEnvironmentAlias)
    } catch (error) {
      const lower = targetEnvironmentAlias.toLowerCase()
      const isAliasError =
        error instanceof Error &&
        ENVIRONMENT_ALIAS_ERRORS.some((m) => error.message.includes(m))

      if (!isAliasError || targetEnvironmentAlias === lower) {
        throw error
      }

      core.info(
        `Environment alias case sensitivity detected in ${operationName}. Retrying with lowercase: ${targetEnvironmentAlias} -> ${lower}`
      )
      return await request(lower)
    }
  }

  private async retryWithRateLimit<T>(
    request: () => Promise<T>,
    maxRetries: number = 3
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request()
      } catch (error) {
        if (
          !(error instanceof UmbracoCloudApiError) ||
          error.status !== 429 ||
          attempt >= maxRetries
        ) {
          throw error
        }

        const retryDelay = retryDelayFor(
          error,
          this.rateLimitBaseDelayMs * Math.pow(2, attempt - 1)
        )

        core.info(
          `Rate limit exceeded (attempt ${attempt}/${maxRetries}). Retrying in ${retryDelay}ms...`
        )
        await sleep(retryDelay)
      }
    }
  }

  async startDeployment(request: DeploymentRequest): Promise<string> {
    const url = `${this.projectUrl}/deployments`

    core.debug(`Starting deployment at ${url}`)

    return this.retryWithLowercaseEnvironmentAlias(
      async (alias) => {
        const body = { ...request, targetEnvironmentAlias: alias }
        const response = await this.retryWithRateLimit(() =>
          this.send(
            url,
            {
              method: 'POST',
              headers: this.getHeaders(),
              body: JSON.stringify(body)
            },
            'startDeployment',
            'Failed to start deployment',
            { targetEnvironmentAlias: alias }
          )
        )

        const data = (await response.json()) as DeploymentResponse
        core.debug(`Deployment started successfully: ${JSON.stringify(data)}`)
        return data.deploymentId
      },
      request.targetEnvironmentAlias,
      'startDeployment'
    )
  }

  /**
   * Fetches the current deployment status once. When `lastModifiedUtc` is
   * given, only status messages newer than that timestamp are returned.
   */
  async getDeploymentStatus(
    deploymentId: string,
    lastModifiedUtc?: string
  ): Promise<DeploymentResponse> {
    const query = lastModifiedUtc
      ? `?lastModifiedUtc=${encodeURIComponent(lastModifiedUtc)}`
      : ''
    const url = `${this.projectUrl}/deployments/${encodeURIComponent(deploymentId)}${query}`

    const response = await this.retryWithRateLimit(() =>
      this.send(
        url,
        { method: 'GET', headers: this.getHeaders() },
        'getDeploymentStatus',
        'Failed to get deployment status',
        { deploymentId, hasLastModifiedUtc: Boolean(lastModifiedUtc) }
      )
    )

    const data = (await response.json()) as DeploymentResponse
    // Cloud status messages can contain signed (SAS) links, e.g. to the NuGet
    // restore log. They end up in job logs, outputs and PR bodies, so strip
    // the signature before anything else sees them.
    if (Array.isArray(data.deploymentStatusMessages)) {
      data.deploymentStatusMessages = data.deploymentStatusMessages.map(
        (msg) => ({ ...msg, message: redactSignedUrls(msg.message ?? '') })
      )
    }
    return data
  }

  async addDeploymentArtifact(
    filePath: string,
    description?: string,
    version?: string
  ): Promise<string> {
    const url = `${this.projectUrl}/deployments/artifacts`

    if (!filePath) {
      throw new Error('File path is required for artifact upload')
    }

    if (!fs.existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`)
    }

    core.debug(`Uploading artifact: ${filePath}`)

    // openAsBlob streams from disk lazily and can be re-sent on every attempt
    // without holding the whole zip in memory.
    const blob = await fs.openAsBlob(filePath, { type: 'application/zip' })
    const fileName = path.basename(filePath) || 'artifact.zip'

    for (let attempt = 1; attempt <= this.uploadRetries; attempt++) {
      core.info(`Upload attempt ${attempt}/${this.uploadRetries}...`)

      const formData = new FormData()
      formData.append('file', blob, fileName)
      if (description) formData.append('description', description)
      if (version) formData.append('version', version)

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.uploadTimeoutMs
      )

      try {
        const response = await this.send(
          url,
          {
            method: 'POST',
            // No Content-Type: fetch sets the multipart boundary itself
            headers: { 'Umbraco-Cloud-Api-Key': this.apiKey },
            body: formData,
            signal: controller.signal
          },
          'addDeploymentArtifact',
          'Failed to upload artifact',
          { fileName, attempt }
        )

        const data = (await response.json()) as ArtifactResponse
        core.info(`Artifact uploaded successfully: ${data.artifactId}`)
        return data.artifactId
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          core.warning(
            `Upload attempt ${attempt} timed out after ${this.uploadTimeoutMs}ms`
          )
        } else {
          core.warning(`Upload attempt ${attempt} failed: ${error}`)
        }

        if (attempt >= this.uploadRetries || !isRetryableError(error)) {
          throw error
        }

        const delay = retryDelayFor(
          error,
          this.uploadRetryDelayMs * Math.pow(2, attempt - 1)
        )
        core.info(`Waiting ${delay}ms before retry...`)
        await sleep(delay)
      } finally {
        clearTimeout(timeoutId)
      }
    }

    // Unreachable: the loop either returns or throws on the last attempt
    throw new Error('Upload failed after all retry attempts')
  }

  async getChangesById(
    deploymentId: string,
    targetEnvironmentAlias: string,
    maxRetries: number = 5,
    retryDelayMs: number = 10000
  ): Promise<ChangesResponse> {
    core.debug(
      `Getting changes for deploymentId: ${deploymentId}, targetEnvironmentAlias: ${targetEnvironmentAlias}`
    )

    const fetchChanges = async (alias: string): Promise<ChangesResponse> => {
      const url = `${this.projectUrl}/deployments/${encodeURIComponent(deploymentId)}/diff?targetEnvironmentAlias=${encodeURIComponent(alias)}`

      for (let attempt = 1; ; attempt++) {
        try {
          const response = await this.send(
            url,
            { method: 'GET', headers: this.getHeaders() },
            'getChangesById',
            'Failed to get changes',
            { deploymentId, targetEnvironmentAlias: alias }
          )

          if (response.status === 204) {
            return { changes: '' }
          }
          return { changes: await response.text() }
        } catch (error) {
          // The Cloud site extension is sometimes briefly unavailable right
          // after a deployment; those surface as 5xx and are worth retrying.
          if (!isRetryableError(error) || attempt >= maxRetries) {
            throw error
          }
          const delay = retryDelayFor(error, retryDelayMs)
          core.warning(
            `Changes endpoint not responding (attempt ${attempt}/${maxRetries}). ` +
              `Retrying in ${delay / 1000} seconds...`
          )
          await sleep(delay)
        }
      }
    }

    return this.retryWithLowercaseEnvironmentAlias(
      fetchChanges,
      targetEnvironmentAlias,
      'getChangesById'
    )
  }

  async getDeployments(
    skip: number = 0,
    take: number = 100,
    includeNullDeployments: boolean = true,
    targetEnvironmentAlias?: string
  ): Promise<DeploymentListResponse> {
    let url = `${this.projectUrl}/deployments?skip=${skip}&take=${take}&includeNullDeployments=${includeNullDeployments}`

    if (targetEnvironmentAlias) {
      url += `&targetEnvironmentAlias=${encodeURIComponent(targetEnvironmentAlias)}`
    }

    core.debug(`Getting deployments from: ${url}`)

    const response = await this.retryWithRateLimit(() =>
      this.send(
        url,
        { method: 'GET', headers: this.getHeaders() },
        'getDeployments',
        'Failed to get deployments',
        { skip, take, includeNullDeployments, targetEnvironmentAlias }
      )
    )

    return (await response.json()) as DeploymentListResponse
  }

  async getLatestCompletedDeployment(
    targetEnvironmentAlias: string
  ): Promise<string | null> {
    core.debug('Finding latest completed deployment with changes...')

    const take = 10
    const maxPages = 20

    for (let page = 0, skip = 0; page < maxPages; page++, skip += take) {
      const deployments = await this.getDeployments(
        skip,
        take,
        false, // Only deployments with changes
        targetEnvironmentAlias
      )

      const completed = deployments.data.find((d) => d.state === 'Completed')
      if (completed) {
        core.debug(`Found latest completed deployment: ${completed.id}`)
        return completed.id
      }

      if (
        deployments.data.length < take ||
        skip + take >= deployments.totalItems
      ) {
        break
      }
    }

    core.debug('No completed deployments with changes found')
    return null
  }

  /**
   * Returns status messages that look like errors for the given deployment.
   * Fetches the full message history (no lastModifiedUtc filter).
   */
  async getDeploymentErrorDetails(deploymentId: string): Promise<string[]> {
    try {
      const deployment = await this.getDeploymentStatus(deploymentId)
      return (deployment.deploymentStatusMessages || [])
        .filter((msg) => ERROR_MESSAGE_PATTERN.test(msg.message))
        .map((msg) => `[${msg.timestampUtc}] ${msg.message}`)
    } catch (error) {
      core.debug(`Could not retrieve deployment error details: ${error}`)
      return []
    }
  }
}
