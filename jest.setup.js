// Mock @actions/core module
jest.mock('@actions/core', () => ({
  getInput: jest.fn(),
  getBooleanInput: jest.fn(),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warning: jest.fn(),
  notice: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  isDebug: jest.fn(),
  toPosixPath: jest.fn(),
  toWin32Path: jest.fn(),
  toPlatformPath: jest.fn()
}))

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  promises: {
    access: jest.fn()
  }
}))

// Mock path module
jest.mock('path', () => ({
  basename: jest.fn(),
  dirname: jest.fn(),
  join: jest.fn(),
  resolve: jest.fn()
}))

// Mock fetch globally
global.fetch = jest.fn()

// Mock FormData
global.FormData = jest.fn().mockImplementation(() => ({
  append: jest.fn()
}))

// Mock Blob
global.Blob = jest.fn().mockImplementation((content) => content)
