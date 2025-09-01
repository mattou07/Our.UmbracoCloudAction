import JSZip from 'jszip'

// Import the function
import { removeExcludedPaths } from '../src/actions/add-artifact.js'

describe('removeExcludedPaths', () => {
  test('removes files matching excluded paths', () => {
    const zip = new JSZip()
    zip.file('.git/config', 'data')
    zip.file('.github/workflow.yml', 'data')
    zip.file('src/index.js', 'data')

    removeExcludedPaths(zip, '.git/,.github/')

    expect(zip.files['.git/config']).toBeUndefined()
    expect(zip.files['.github/workflow.yml']).toBeUndefined()
    expect(zip.files['src/index.js']).toBeDefined()
  })

  test('throws error for invalid format (space-separated)', () => {
    const zip = new JSZip()
    expect(() => removeExcludedPaths(zip, 'foo bar')).toThrow(
      'Invalid excluded-paths format'
    )
  })

  test('throws error for mixed separators', () => {
    const zip = new JSZip()
    expect(() => removeExcludedPaths(zip, 'foo/bar\\baz')).toThrow(
      'contains mixed separators'
    )
  })

  test('throws error if excluded path not found', () => {
    const zip = new JSZip()
    zip.file('src/index.js', 'data')
    expect(() => removeExcludedPaths(zip, 'notfound/')).toThrow(
      'The following excluded paths were not found in the artifact'
    )
  })

  test('throws error if no files removed', () => {
    const zip = new JSZip()
    zip.file('src/index.js', 'data')
    expect(() => removeExcludedPaths(zip, 'src/doesnotexist/')).toThrow(
      'The following excluded paths were not found in the artifact'
    )
  })

  test('throws error for unsafe path', () => {
    const zip = new JSZip()
    expect(() => removeExcludedPaths(zip, '../etc/passwd')).toThrow(
      'Invalid path'
    )
    expect(() => removeExcludedPaths(zip, '/absolute/path')).toThrow(
      'Invalid path'
    )
  })
})
