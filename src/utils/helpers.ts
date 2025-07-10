import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs'

/**
 * Helper function to validate git repository in a directory
 */
export async function validateGitRepository(
  directoryPath: string,
  context: string
): Promise<void> {
  core.info(`Validating git repository ${context}...`)
  try {
    // Store current working directory
    const originalCwd = process.cwd()

    try {
      process.chdir(directoryPath)

      // Check if .git directory exists
      if (!fs.existsSync('.git')) {
        throw new Error(`No .git directory found in ${directoryPath}`)
      }

      // Run basic git validation
      const exitCode = await exec.exec('git', ['status', '--porcelain'], {
        silent: true,
        ignoreReturnCode: true
      })

      if (exitCode !== 0) {
        throw new Error('Git status command failed')
      }

      core.info(`Git repository validation successful ${context}`)
    } finally {
      process.chdir(originalCwd)
    }
  } catch (error) {
    core.setFailed(`Failed to validate git repository ${context}: ${error}`)
    throw error
  }
}

/**
 * Create a timeout promise that rejects after the specified duration
 */
export function createTimeoutPromise(timeoutMs: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Operation timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
}

/**
 * Helper function to sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Validate required inputs for actions
 */
export function validateRequiredInputs(
  inputs: Record<string, unknown>,
  required: string[]
): void {
  const missing = required.filter((key) => !inputs[key])
  if (missing.length > 0) {
    throw new Error(`Missing required inputs: ${missing.join(', ')}`)
  }
}

/**
 * Parse boolean input from GitHub Actions
 */
export function parseBooleanInput(value: string | undefined): boolean {
  if (!value) return false
  return value.toLowerCase() === 'true'
}

/**
 * Parse integer input from GitHub Actions
 */
export function parseIntegerInput(
  value: string | undefined,
  defaultValue: number
): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) ? defaultValue : parsed
}
