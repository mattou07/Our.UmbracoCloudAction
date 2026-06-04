import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'
import { DefaultArtifactClient } from '@actions/artifact'

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

async function safeReadResponseBody(response: Response): Promise<unknown> {
  try {
    const bodyText = await response.clone().text()
    return tryParseJson(truncate(bodyText))
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

  const baseDir = process.env.RUNNER_TEMP || process.cwd()
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
  const startedAt = Date.now()
  const method = init.method || 'GET'
  const requestBody = serializeRequestBody(init.body)

  try {
    const response = await fetch(url, init)
    const responseBody = await safeReadResponseBody(response)

    appendLog({
      timestampUtc: new Date().toISOString(),
      operation: context.operation,
      method,
      url,
      durationMs: Date.now() - startedAt,
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      requestBody,
      responseBody,
      metadata: context.metadata
    })

    return response
  } catch (error) {
    appendLog({
      timestampUtc: new Date().toISOString(),
      operation: context.operation,
      method,
      url,
      durationMs: Date.now() - startedAt,
      requestBody,
      error: error instanceof Error ? error.message : String(error),
      metadata: context.metadata
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
