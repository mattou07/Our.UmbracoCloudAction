import { jest } from '@jest/globals'

const info = jest.fn()

jest.unstable_mockModule('@actions/core', () => ({ info }))

describe('safe-log', () => {
  let neutraliseWorkflowCommands: typeof import('../../src/utils/safe-log.js').neutraliseWorkflowCommands
  let safeInfo: typeof import('../../src/utils/safe-log.js').safeInfo

  beforeAll(async () => {
    const mod = await import('../../src/utils/safe-log.js')
    neutraliseWorkflowCommands = mod.neutraliseWorkflowCommands
    safeInfo = mod.safeInfo
  })

  beforeEach(() => {
    info.mockReset()
  })

  it('breaks up a leading :: on a single line', () => {
    expect(neutraliseWorkflowCommands('::add-mask::x')).toBe(
      ':\u200b:add-mask::x'
    )
  })

  it('handles indented commands, which the runner trims', () => {
    expect(neutraliseWorkflowCommands('  ::add-mask::x')).toBe(
      '  :\u200b:add-mask::x'
    )
  })

  it('handles every line of multi-line CRLF text', () => {
    expect(
      neutraliseWorkflowCommands('build ok\r\n::error::boom\r\n\t::warning::w')
    ).toBe('build ok\n:\u200b:error::boom\n\t:\u200b:warning::w')
  })

  it('treats a bare carriage return as a line break', () => {
    expect(neutraliseWorkflowCommands('a\r::stop-commands::t')).toBe(
      'a\n:\u200b:stop-commands::t'
    )
  })

  it('leaves :: in the middle of a line, and single colons, untouched', () => {
    expect(neutraliseWorkflowCommands('see a::b and :x')).toBe(
      'see a::b and :x'
    )
    expect(neutraliseWorkflowCommands('')).toBe('')
  })

  it('safeInfo logs the neutralised text', () => {
    safeInfo('ok\n::error::x')
    expect(info).toHaveBeenCalledWith('ok\n:\u200b:error::x')
  })
})
