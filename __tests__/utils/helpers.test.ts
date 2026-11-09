import { jest } from '@jest/globals'
import { sleep } from '../../src/utils/helpers.js'

describe('sleep', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('resolves only once the requested time has elapsed', async () => {
    jest.useFakeTimers()
    let resolved = false
    const pending = sleep(5000).then(() => {
      resolved = true
    })

    await jest.advanceTimersByTimeAsync(4999)
    expect(resolved).toBe(false)

    await jest.advanceTimersByTimeAsync(1)
    await pending
    expect(resolved).toBe(true)
  })

  it('resolves with undefined', async () => {
    await expect(sleep(1)).resolves.toBeUndefined()
  })
})
