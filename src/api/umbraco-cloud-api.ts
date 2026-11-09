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

/*
 * Structure decides, text enriches.
 *
 * Umbraco Cloud may reword its error and status messages at any time, so
 * control flow here never depends on exact wording. Decisions are made from
 * structure: HTTP status codes, problem-details `type`, deployment states,
 * message position (e.g. "the messages just before the terminal one") and
 * URL shape (blob host + `sig=`). Text matching is only ever used as an extra
 * hint (to surface more detail or to keep older checks working), always with
 * a structural fallback that still does the right thing if the text changes.
 */

export const DEFAULT_BASE_URL = 'https://api.cloud.umbraco.com'

/** States in which a deployment is still running. Anything else is terminal. */
export const IN_PROGRESS_STATES = ['Pending', 'InProgress', 'Queued']

/** Umbraco Cloud's v2 artifact upload limit (multipart body length). */
export const MAX_ARTIFACT_SIZE_BYTES = 268435456

const MAX_ERROR_SUMMARY_LENGTH = 500
const LOG_FETCH_TIMEOUT_MS = 15000

/**
 * Error thrown for non-2xx responses from the Umbraco Cloud API.
 * Carries the HTTP status so callers can decide whether to retry.
 */
export class UmbracoCloudApiError extends Error {
  readonly status: number
  readonly body: string
  readonly retryAfterSeconds?: number
  /** Problem-details `type` from the body (e.g. 'CloudNullDeployment'), if any */
  readonly problemType?: string
  /** Problem-details `title` from the body, if any */
  readonly title?: string

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
    const parsed = parseErrorBody(body)
    this.problemType = parsed.problemType
    this.title = parsed.title
  }
}

interface ParsedErrorBody {
  summary: string
  problemType?: string
  title?: string
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function flattenErrors(errors: unknown): string | undefined {
  if (!errors || typeof errors !== 'object') return undefined
  const parts: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.trim()) parts.push(value)
    } else if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit)
    }
  }
  visit(errors)
  return parts.length ? parts.join('; ') : undefined
}

/**
 * Turns a Cloud error body into a single-line summary. Handles both the API
 * gateway format `{statusCode, message}` and RFC problem details
 * `{type, title, status, detail, errors}`, falling back to the raw text.
 */
export function parseErrorBody(body: string): ParsedErrorBody {
  let summary: string | undefined
  let problemType: string | undefined
  let title: string | undefined

  const trimmed = (body ?? '').trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      problemType = nonEmptyString(parsed.type)
      title = nonEmptyString(parsed.title)
      summary =
        nonEmptyString(parsed.detail) ??
        nonEmptyString(parsed.message) ??
        flattenErrors(parsed.errors) ??
        title
      // A non-URL type is a machine-readable code worth keeping in the text
      if (summary && problemType && !/^https?:\/\//i.test(problemType)) {
        summary = `${problemType}: ${summary}`
      }
    } catch {
      // not JSON — fall back to the raw text
    }
  }

  let single = collapseWhitespace(summary ?? trimmed)
  if (single.length > MAX_ERROR_SUMMARY_LENGTH) {
    single = `${single.slice(0, MAX_ERROR_SUMMARY_LENGTH)}…`
  }
  return { summary: single || '(empty response body)', problemType, title }
}

/** Formats milliseconds as e.g. `45s`, `1m 05s` or `1h 02m 03s`. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
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
 * Text hint for status messages worth surfacing when a deployment fails.
 * Cloud reports some failures without the word "error", e.g. "Cannot apply
 * update because the following packages would be downgraded: ...". This is
 * only a hint: the messages just before the terminal one are always surfaced
 * too (see getDeploymentErrorDetails).
 */
const ERROR_MESSAGE_PATTERN =
  /error|fail|exception|cannot|could not|unable|does not exist|no \.umbraco|downgrad|invalid/i

/** Pure progress lines that never explain a failure. */
const PROGRESS_MESSAGE_PATTERNS = [
  /^no changes to deploy\b/i,
  /^delete updating marker$/i,
  /^verify deployment$/i,
  /^git (commit|push)$/i,
  /^(skipped\s*:\s*)?(nuget restore|dotnet build)$/i,
  /^picking up kudu deployment stream$/i,
  /^kudu deployment log id:/i,
  /^kept the cloud environment's umbraco-cloud\.json/i,
  /^(deleting repository files|copying files to repository|git stage)$/i
]

/** Number of messages before the terminal one that are always surfaced. */
const TRAILING_CONTEXT_MESSAGES = 3

const LOG_ERROR_LINE_PATTERN = /\berror\b|NU\d{4}|CS\d{4}|Build FAILED/i

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

function isProgressMessage(message: string): boolean {
  const trimmed = message.trim()
  return PROGRESS_MESSAGE_PATTERNS.some((p) => p.test(trimmed))
}

/**
 * Reduces a status message to its useful part: multi-line messages (e.g. a
 * Kudu build output block) keep only the lines that look like errors.
 */
function condenseMessage(message: string): string {
  const lines = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length <= 1) return message.trim()
  const errorLines = lines.filter((l) => ERROR_MESSAGE_PATTERN.test(l))
  return (errorLines.length ? errorLines : lines).join('\n')
}

const URL_PATTERN = /https:\/\/[^\s"'<>]+/gi

/** Signed Azure blob URLs (e.g. Cloud build/restore logs) in a message. */
function findSignedBlobUrls(message: string): string[] {
  const found: string[] = []
  for (const candidate of message.match(URL_PATTERN) ?? []) {
    try {
      const url = new URL(candidate)
      if (
        url.hostname.toLowerCase().endsWith('.blob.core.windows.net') &&
        url.searchParams.has('sig')
      ) {
        found.push(candidate)
      }
    } catch {
      // not a valid URL
    }
  }
  return found
}

/** `.../<deploymentId>-NugetRestore.txt?sig=...` -> `NugetRestore.txt` */
function logNameFromUrl(signedUrl: string): string {
  // Only called with URLs findSignedBlobUrls already parsed successfully
  const segments = new URL(signedUrl).pathname.split('/').filter(Boolean)
  const file = decodeURIComponent(segments[segments.length - 1] ?? 'log')
  return (
    file.replace(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i,
      ''
    ) || file
  )
}

export class UmbracoCloudAPI {
  private readonly baseUrl: string
  private readonly projectId: string
  private readonly apiKey: string
  private readonly uploadRetries: number
  private readonly uploadRetryDelayMs: number
  private readonly uploadTimeoutMs: number
  private readonly rateLimitBaseDelayMs: number
  /**
   * Signed log links seen in status messages, keyed by deployment id. Kept
   * private and in memory only: everything returned or logged is redacted.
   */
  private readonly signedLogUrls = new Map<string, Set<string>>()

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
      const { summary } = parseErrorBody(body)
      const statusText = response.statusText ? ` ${response.statusText}` : ''
      throw new UmbracoCloudApiError(
        `${errorPrefix}: ${response.status}${statusText} - ${summary}`,
        response.status,
        body,
        parseRetryAfter(response, body)
      )
    }

    return response
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

  /**
   * Structural check behind a 409: is a deployment actually running? Never
   * throws; returns false when it can't tell, so the 409 is surfaced as-is.
   */
  private async hasRunningDeployment(alias: string): Promise<boolean> {
    const isRunning = (list: DeploymentListResponse) =>
      (list?.data ?? []).some((d) => IN_PROGRESS_STATES.includes(d.state))
    try {
      return isRunning(await this.getDeployments(0, 5, true, alias))
    } catch (error) {
      core.debug(`Could not list deployments for ${alias}: ${error}`)
    }
    try {
      return isRunning(await this.getDeployments(0, 5, true))
    } catch (error) {
      core.debug(`Could not list deployments: ${error}`)
      return false
    }
  }

  async startDeployment(
    request: DeploymentRequest,
    options: {
      waitForRunningDeploymentMs?: number
      pollIntervalMs?: number
    } = {}
  ): Promise<string> {
    const url = `${this.projectUrl}/deployments`
    const waitMs = Math.max(0, options.waitForRunningDeploymentMs ?? 0)
    const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 30000)

    core.debug(`Starting deployment at ${url}`)

    const alias = request.targetEnvironmentAlias
    let waitedMs = 0

    for (;;) {
      try {
        const response = await this.retryWithRateLimit(() =>
          this.send(
            url,
            {
              method: 'POST',
              headers: this.getHeaders(),
              body: JSON.stringify(request)
            },
            'startDeployment',
            'Failed to start deployment',
            { targetEnvironmentAlias: alias }
          )
        )

        const data = (await response.json()) as DeploymentResponse
        core.debug(`Deployment started successfully: ${JSON.stringify(data)}`)
        return data.deploymentId
      } catch (error) {
        // Structure decides: a 409 *and* a deployment listed as running.
        // The 409's wording is only logged.
        if (
          waitMs <= 0 ||
          !(error instanceof UmbracoCloudApiError) ||
          error.status !== 409 ||
          !(await this.hasRunningDeployment(alias))
        ) {
          throw error
        }

        if (waitedMs >= waitMs) {
          const minutes = Math.round((waitMs / 60000) * 10) / 10
          throw new UmbracoCloudApiError(
            `Another deployment was still in progress after waiting ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
              'Use a `concurrency:` group in your workflow to serialise deployments. ' +
              `(${error.message})`,
            error.status,
            error.body,
            error.retryAfterSeconds
          )
        }

        const delay = Math.min(pollIntervalMs, waitMs - waitedMs)
        core.info(
          `Another deployment is in progress on ${alias}; waiting ${Math.round(delay / 1000)}s before retrying…` +
            (error.title ? ` (${error.title})` : '')
        )
        await sleep(delay)
        waitedMs += delay
      }
    }
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
      // Keep the signed log links privately first, so getFailureLogExcerpts
      // can still read them after the returned copy has been redacted.
      for (const msg of data.deploymentStatusMessages) {
        for (const signed of findSignedBlobUrls(msg.message ?? '')) {
          let urls = this.signedLogUrls.get(deploymentId)
          if (!urls) {
            urls = new Set()
            this.signedLogUrls.set(deploymentId, urls)
          }
          urls.add(signed)
        }
      }
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

    const size = fs.statSync(filePath).size
    if (size > MAX_ARTIFACT_SIZE_BYTES) {
      const toMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1)
      throw new Error(
        `Artifact ${path.basename(filePath)} is ${toMb(size)} MB (${size} bytes), ` +
          `which exceeds Umbraco Cloud's upload limit of ${toMb(MAX_ARTIFACT_SIZE_BYTES)} MB ` +
          `(${MAX_ARTIFACT_SIZE_BYTES} bytes). Exclude unneeded files from the artifact.`
      )
    }

    core.debug(`Uploading artifact: ${filePath}`)

    // openAsBlob streams from disk lazily and can be re-sent on every attempt
    // without holding the whole zip in memory.
    const blob = await fs.openAsBlob(filePath, { type: 'application/zip' })
    const fileName = path.basename(filePath) || 'artifact.zip'

    // Every attempt either returns or, on the last one, throws
    for (let attempt = 1; ; attempt++) {
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
          if (error instanceof Error && error.name === 'AbortError') {
            const timeoutError = new Error(
              `Artifact upload timed out after ${attempt} attempt(s) of ${this.uploadTimeoutMs}ms each. ` +
                'Increase the upload-timeout input (milliseconds) or reduce the artifact size.',
              { cause: error }
            )
            timeoutError.name = 'UploadTimeoutError'
            throw timeoutError
          }
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

    const alias = targetEnvironmentAlias
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
        const seconds = delay / 1000
        if (error instanceof UmbracoCloudApiError && error.status === 429) {
          core.warning(
            `Rate limited by Umbraco Cloud (attempt ${attempt}/${maxRetries}). Retrying in ${seconds}s...`
          )
        } else {
          core.warning(
            `Changes endpoint not responding (attempt ${attempt}/${maxRetries}). ` +
              `Retrying in ${seconds} seconds...`
          )
        }
        await sleep(delay)
      }
    }
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
   * Returns the status messages that explain why a deployment failed.
   * Fetches the full message history (no lastModifiedUtc filter).
   *
   * Structural: the last few non-progress messages before the terminal one
   * are always included, whatever their wording. Text hint: messages that
   * look like errors anywhere in the history are included too.
   */
  async getDeploymentErrorDetails(deploymentId: string): Promise<string[]> {
    try {
      const deployment = await this.getDeploymentStatus(deploymentId)
      const messages = (deployment.deploymentStatusMessages || []).filter(
        (msg) => typeof msg?.message === 'string' && msg.message.trim()
      )

      // The final message is the terminal "Deployment <id> failed" one when
      // it names this deployment (wording-independent) or reads like it.
      const last = messages[messages.length - 1]
      const hasTerminal =
        last !== undefined &&
        (last.message.includes(deploymentId) ||
          /^\s*deployment \S+ failed\s*$/i.test(last.message))
      const candidates = hasTerminal ? messages.slice(0, -1) : messages

      const selected = new Set<number>()
      candidates.forEach((msg, i) => {
        if (ERROR_MESSAGE_PATTERN.test(msg.message)) selected.add(i)
      })
      const meaningful = candidates
        .map((msg, i) => ({ msg, i }))
        .filter(({ msg }) => !isProgressMessage(msg.message))
      for (const { i } of meaningful.slice(-TRAILING_CONTEXT_MESSAGES)) {
        selected.add(i)
      }

      const seen = new Set<string>()
      const details: string[] = []
      for (const i of [...selected].sort((a, b) => a - b)) {
        const msg = candidates[i]
        const text = condenseMessage(msg.message)
        if (!text || seen.has(text)) continue
        seen.add(text)
        details.push(`[${msg.timestampUtc}] ${text}`)
      }
      return details
    } catch (error) {
      core.debug(`Could not retrieve deployment error details: ${error}`)
      return []
    }
  }

  /**
   * Fetches the signed build/restore logs Cloud linked to in this
   * deployment's status messages (captured by getDeploymentStatus) and
   * returns their error lines. Never throws.
   */
  async getFailureLogExcerpts(
    deploymentId: string,
    maxLines = 40
  ): Promise<Array<{ name: string; lines: string[] }>> {
    const urls = [...(this.signedLogUrls.get(deploymentId) ?? [])]
    const excerpts: Array<{ name: string; lines: string[] }> = []

    for (const signedUrl of urls) {
      const safeUrl = redactSignedUrls(signedUrl)
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        LOG_FETCH_TIMEOUT_MS
      )
      try {
        // Third-party host: plain fetch, never the Cloud API key header.
        const response = await fetch(signedUrl, { signal: controller.signal })
        if (!response.ok) {
          core.debug(`Could not fetch log ${safeUrl}: HTTP ${response.status}`)
          continue
        }
        const text = await response.text()
        const lines = [
          ...new Set(
            text
              .split(/\r?\n/)
              .filter((line) => LOG_ERROR_LINE_PATTERN.test(line))
              .map((line) => line.trim())
              .filter(Boolean)
          )
        ].slice(0, Math.max(0, maxLines))
        if (lines.length) {
          excerpts.push({ name: logNameFromUrl(signedUrl), lines })
        }
      } catch (error) {
        core.debug(
          `Could not fetch log ${safeUrl}: ${redactSignedUrls(String(error))}`
        )
      } finally {
        clearTimeout(timeoutId)
      }
    }

    return excerpts
  }
}
