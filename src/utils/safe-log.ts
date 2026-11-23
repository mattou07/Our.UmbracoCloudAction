import * as core from '@actions/core'

const ZERO_WIDTH_SPACE = '​'

/**
 * The runner trims leading whitespace and then treats a line starting with
 * `::` as a workflow command. Text from Umbraco Cloud is untrusted (and can be
 * multi-line), so a zero-width space is inserted between the leading colons of
 * any such line to stop it being interpreted as a command.
 */
export function neutraliseWorkflowCommands(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => {
      const match = /^(\s*):(?=:)/.exec(line)
      return match
        ? `${match[0]}${ZERO_WIDTH_SPACE}${line.slice(match[0].length)}`
        : line
    })
    .join('\n')
}

/** `core.info` for untrusted text: neutralises workflow commands first. */
export function safeInfo(text: string): void {
  core.info(neutraliseWorkflowCommands(text))
}
