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
  inputs: object,
  required: string[]
): void {
  const record = inputs as Record<string, unknown>
  const missing = required.filter((key) => !record[key])
  if (missing.length > 0) {
    throw new Error(`Missing required inputs: ${missing.join(', ')}`)
  }
}

/**
 * Parse an integer input, falling back to a default when empty.
 * Throws when the value is not a whole number at or above `min`, so a typo
 * fails the run immediately instead of producing NaN-driven behaviour later.
 */
export function parseIntegerInput(
  name: string,
  value: string | undefined,
  defaultValue: number,
  min = 1
): number {
  const trimmed = value?.trim()
  if (!trimmed) return defaultValue

  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid value for input "${name}": "${value}" is not a whole number`
    )
  }

  const parsed = parseInt(trimmed, 10)
  if (parsed < min) {
    throw new Error(
      `Invalid value for input "${name}": ${parsed} must be at least ${min}`
    )
  }
  return parsed
}

/**
 * Validate that a base URL uses HTTPS (the API key is sent with every request)
 * and return it without a trailing slash.
 */
export function parseHttpsBaseUrl(name: string, value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(
      `Invalid value for input "${name}": "${value}" is not a URL`
    )
  }

  if (url.protocol !== 'https:') {
    throw new Error(
      `Invalid value for input "${name}": "${value}" must use https so the API key is not sent in clear text`
    )
  }

  return value.replace(/\/+$/, '')
}
