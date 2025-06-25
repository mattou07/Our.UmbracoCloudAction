import { describe, test, expect } from '@jest/globals'

// Only test that the action loads and handles unknown action

describe('Umbraco Cloud Deployment Action (smoke test)', () => {
  test('should not throw when imported and run', async () => {
    const { run } = await import('../src/main.js')
    await expect(run()).resolves.not.toThrow()
  })

  test('should fail gracefully on unknown action', async () => {
    // Patch process.env to simulate inputs
    process.env['INPUT_PROJECTID'] = 'dummy'
    process.env['INPUT_APIKEY'] = 'dummy'
    process.env['INPUT_ACTION'] = 'unknown-action'

    // Mock @actions/core.setFailed
    const core = await import('@actions/core')
    const setFailedSpy = jest
      .spyOn(core, 'setFailed')
      .mockImplementation(() => {})

    const { run } = await import('../src/main.js')
    await run()

    expect(setFailedSpy).toHaveBeenCalledWith(
      'Unknown action: unknown-action. Supported actions: start-deployment, check-status, add-artifact, get-changes, apply-patch'
    )

    setFailedSpy.mockRestore()
  })
})
