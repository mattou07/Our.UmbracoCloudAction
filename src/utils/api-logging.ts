import * as core from '@actions/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { DefaultArtifactClient } from '@actions/artifact'
import { REDACTED, redactSignedUrls } from './redact.js'

const DEFAULT_ARTIFACT_NAME = 'umbraco-cloud-api-log'
const MAX_LOGGED_BODY_LENGTH = 100_000

interface ApiLogContext {
  operation?: string
  metadata?: Record<string, unknown>
}

interface ApiLogEntry {
  timestampUtc: string
  operation?: string
  method: string
  url: string
  durationMs: number
  ok?: boolean
  status?: number
  statusText?: string
  requestBody?: unknown
  responseBody?: unknown
  error?: string
  metadata?: Record<string, unknown>
}

let loggingEnabled = false
let logFilePath = ''
let artifactName = DEFAULT_ARTIFACT_NAME

// Fallback for bodies that could not be parsed (e.g. truncated JSON)
const RAW_BLOB_URL_PATTERN = /("blobUrl"\s*:\s*)"(?:[^"\\]|\\.)*"/gi

function redactString(value: string): string {
  return redactSignedUrls(
    value.replace(RAW_BLOB_URL_PATTERN, `$1"${REDACTED}"`)
  )
}

/** Recursively redacts blobUrl keys and signed URLs in a parsed body. */
function redactValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactString(value)
  }

  if (Array.isArray(value)) {
    return value.map(redactValue)
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      result[key] =
        key.toLowerCase() === 'bloburl' ? REDACTED : redactValue(child)
    }
    return result
  }

  return value
}

function isDiffOperation(context: ApiLogContext): boolean {
  return context.operation?.startsWith('getChangesById') ?? false
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(value)
    } catch {
      // not valid JSON — fall through
    }
  }
  return value
}

function truncate(value: string): string {
  if (value.length <= MAX_LOGGED_BODY_LENGTH) {
    return value
  }

  return `${value.slice(0, MAX_LOGGED_BODY_LENGTH)}...[truncated]`
}

function serializeRequestBody(body: unknown): unknown {
  if (body === undefined || body === null) {
    return undefined
  }

  if (typeof body === 'string') {
    return tryParseJson(truncate(body))
  }

  if (body instanceof URLSearchParams) {
    return truncate(body.toString())
  }

  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    return '[form-data]'
  }

  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return `[blob size=${body.size}]`
  }

  if (body instanceof ArrayBuffer) {
    return `[array-buffer byteLength=${body.byteLength}]`
  }

  return `[request-body type=${Object.prototype.toString.call(body)}]`
}

async function safeReadResponseBody(
  response: Response,
  context: ApiLogContext
): Promise<unknown> {
  try {
    const bodyText = await response.clone().text()
    // The diff endpoint returns source-code patches: never persist them.
    if (isDiffOperation(context)) {
      return `[redacted diff: ${bodyText.length} chars]`
    }
    return redactValue(tryParseJson(truncate(bodyText)))
  } catch (error) {
    return `[response-body read failed: ${error}]`
  }
}

function appendLog(entry: ApiLogEntry): void {
  if (!loggingEnabled || !logFilePath) {
    return
  }

  fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, {
    encoding: 'utf8'
  })
}

export function initializeApiLogging(
  enabled: boolean,
  configuredArtifactName?: string
): void {
  loggingEnabled = enabled
  artifactName = configuredArtifactName || DEFAULT_ARTIFACT_NAME

  if (!enabled) {
    logFilePath = ''
    return
  }

  // Outside a runner (e.g. local-action) use the OS temp dir rather than the
  // working directory, so the log never lands inside the user's repository.
  const baseDir = process.env.RUNNER_TEMP || os.tmpdir()
  const fileName = `umbraco-cloud-api-${Date.now()}.ndjson`
  logFilePath = path.join(baseDir, fileName)

  fs.mkdirSync(path.dirname(logFilePath), { recursive: true })
  fs.writeFileSync(logFilePath, '', { encoding: 'utf8' })

  core.info(`API logging enabled. Writing NDJSON logs to: ${logFilePath}`)
}

export function getApiLogPath(): string {
  return logFilePath
}

export function isApiLoggingEnabled(): boolean {
  return loggingEnabled
}

export async function fetchWithApiLogging(
  url: string,
  init: RequestInit,
  context: ApiLogContext = {}
): Promise<Response> {
  if (!loggingEnabled || !logFilePath) {
    return fetch(url, init)
  }

  const startedAt = Date.now()
  const method = init.method || 'GET'
  const loggedUrl = redactSignedUrls(url)
  const requestBody = redactValue(serializeRequestBody(init.body))
  const metadata = context.metadata
    ? (redactValue(context.metadata) as Record<string, unknown>)
    : undefined

  try {
    const response = await fetch(url, init)
    const responseBody = await safeReadResponseBody(response, context)

    appendLog({
      timestampUtc: new Date().toISOString(),
      operation: context.operation,
      method,
      url: loggedUrl,
      durationMs: Date.now() - startedAt,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      requestBody,
      responseBody,
      metadata
    })

    return response
  } catch (error) {
    appendLog({
      timestampUtc: new Date().toISOString(),
      operation: context.operation,
      method,
      url: loggedUrl,
      durationMs: Date.now() - startedAt,
      requestBody,
      error: redactString(
        error instanceof Error ? error.message : String(error)
      ),
      metadata
    })

    throw error
  }
}

export async function uploadApiLogArtifactIfAvailable(): Promise<void> {
  if (!loggingEnabled || !logFilePath || !fs.existsSync(logFilePath)) {
    return
  }

  const stats = fs.statSync(logFilePath)
  if (stats.size === 0) {
    core.info('API log file is empty. Skipping artifact upload.')
    return
  }

  const artifactClient = new DefaultArtifactClient()

  await artifactClient.uploadArtifact(
    artifactName,
    [logFilePath],
    path.dirname(logFilePath),
    {
      retentionDays: 30
    }
  )

  core.info(`Uploaded API log artifact: ${artifactName} (${stats.size} bytes)`)
}
