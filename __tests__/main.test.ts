import { jest } from '@jest/globals'
import { getActionInputs } from '../src/main.js'

// Simple test approach focusing on what we can test reliably
// Helper to patch process.env for input simulation
type Inputs = Record<string, string | number | boolean | undefined>
function defineEnv(inputs: Inputs) {
  for (const [key, value] of Object.entries(inputs)) {
    process.env[`INPUT_${key.toUpperCase()}`] = value?.toString()
  }
}

describe('main.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset process.env between tests
    for (const key in process.env) {
      if (key.startsWith('INPUT_')) delete process.env[key]
    }
  })

  test('getActionInputs parses all inputs and defaults', () => {
    defineEnv({
      projectId: 'pid',
      apiKey: 'key',
      action: 'start-deployment',
      timeoutSeconds: '123',
      noBuildAndRestore: 'true',
      skipVersionCheck: 'true',
      'upload-retries': '2',
      'upload-retry-delay': '5000',
      'upload-timeout': '30000',
      'excluded-paths': 'foo,bar'
    })
    const inputs = getActionInputs()
    expect(inputs.projectId).toBe('pid')
    expect(inputs.apiKey).toBe('key')
    expect(inputs.action).toBe('start-deployment')
    expect(inputs.timeoutSeconds).toBe(123)
    expect(inputs.noBuildAndRestore).toBe(true)
    expect(inputs.skipVersionCheck).toBe(true)
    expect(inputs.uploadRetries).toBe(2)
    expect(inputs.uploadRetryDelay).toBe(5000)
    expect(inputs.uploadTimeout).toBe(30000)
    expect(inputs.excludedPaths).toBe('foo,bar')
  })

  test('getActionInputs uses defaults for optional inputs', () => {
    defineEnv({
      projectId: 'pid',
      apiKey: 'key',
      action: 'start-deployment',
      noBuildAndRestore: 'false',
      skipVersionCheck: 'false'
    })
    const inputs = getActionInputs()
    expect(inputs.timeoutSeconds).toBe(1200)
    expect(inputs.noBuildAndRestore).toBe(false)
    expect(inputs.skipVersionCheck).toBe(false)
    expect(inputs.uploadRetries).toBe(3)
    expect(inputs.uploadRetryDelay).toBe(10000)
    expect(inputs.uploadTimeout).toBe(60000)
    expect(inputs.excludedPaths).toBe('.git/,.github/')
  })

  test('can load fixture file', async () => {
    const fs = await import('fs/promises')
    const fixture = await fs.readFile('__fixtures__/core.ts', 'utf8')
    expect(fixture).toContain('jest.fn')
  })
})
