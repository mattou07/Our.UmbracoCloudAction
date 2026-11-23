import { jest } from '@jest/globals'
import * as actualFs from 'fs'
import * as os from 'os'
import * as path from 'path'

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn()
}))

const mockLstat = jest.fn(actualFs.lstatSync as (p: string) => actualFs.Stats)
jest.unstable_mockModule('fs', () => ({
  ...actualFs,
  lstatSync: mockLstat
}))

describe('applyVersionFixes', () => {
  let core: any
  let applyVersionFixes: any
  let dir: string

  const write = (rel: string, content: string) => {
    const full = path.join(dir, rel)
    actualFs.mkdirSync(path.dirname(full), { recursive: true })
    actualFs.writeFileSync(full, content, 'utf8')
  }
  const read = (rel: string) =>
    actualFs.readFileSync(path.join(dir, rel), 'utf8')
  const fix = (over: Record<string, string> = {}) => ({
    name: 'Umbraco.Cms',
    version: '17.7.2',
    file: 'src/Contoso.Web/Contoso.Web.csproj',
    ...over
  })

  beforeAll(async () => {
    core = await import('@actions/core')
    applyVersionFixes = (await import('../../src/utils/version-fixes.js'))
      .applyVersionFixes
  })

  beforeEach(() => {
    jest.clearAllMocks()
    dir = actualFs.mkdtempSync(path.join(os.tmpdir(), 'version-fixes-'))
  })

  afterEach(() => {
    actualFs.rmSync(dir, { recursive: true, force: true })
  })

  test('replaces only the Version attribute, whatever the attribute order or quotes', () => {
    write(
      'src/Contoso.Web/Contoso.Web.csproj',
      [
        '<Project>',
        '  <ItemGroup>',
        '    <PackageReference Include="Umbraco.Cms" Version="17.7.1" />',
        '    <PackageReference Version="17.7.1" Include="Umbraco.Cms" PrivateAssets="all" />',
        "    <PackageReference Include='Umbraco.Cms' Version = '17.7.1'></PackageReference>",
        '    <PackageReference Include="Umbraco.Cms.Other" Version="1.0.0" />',
        '  </ItemGroup>',
        '</Project>'
      ].join('\n')
    )

    const applied = applyVersionFixes(dir, [fix()])

    expect(read('src/Contoso.Web/Contoso.Web.csproj')).toBe(
      [
        '<Project>',
        '  <ItemGroup>',
        '    <PackageReference Include="Umbraco.Cms" Version="17.7.2" />',
        '    <PackageReference Version="17.7.2" Include="Umbraco.Cms" PrivateAssets="all" />',
        "    <PackageReference Include='Umbraco.Cms' Version = '17.7.2'></PackageReference>",
        '    <PackageReference Include="Umbraco.Cms.Other" Version="1.0.0" />',
        '  </ItemGroup>',
        '</Project>'
      ].join('\n')
    )
    expect(applied).toHaveLength(3)
    expect(applied[0]).toEqual({
      name: 'Umbraco.Cms',
      file: 'src/Contoso.Web/Contoso.Web.csproj',
      from: '17.7.1',
      to: '17.7.2'
    })
    expect(core.info).toHaveBeenCalledWith(
      '- Umbraco.Cms: 17.7.1 → 17.7.2 (src/Contoso.Web/Contoso.Web.csproj)'
    )
  })

  test('matches the package name case-insensitively and exactly', () => {
    write(
      'a.csproj',
      '<PackageReference Include="UMBRACO.cms" Version="1.0.0" />\n<PackageReference Include="Umbraco.Cms.Core" Version="1.0.0" />'
    )

    applyVersionFixes(dir, [fix({ file: 'a.csproj', version: '2.0.0' })])

    expect(read('a.csproj')).toBe(
      '<PackageReference Include="UMBRACO.cms" Version="2.0.0" />\n<PackageReference Include="Umbraco.Cms.Core" Version="1.0.0" />'
    )
  })

  test('applies several packages across two files', () => {
    write('a/A.csproj', '<PackageReference Include="Pkg.One" Version="1.0" />')
    write(
      'b/B.csproj',
      '<PackageReference Include="Pkg.One" Version="1.1" />\n<PackageReference Include="Pkg.Two" Version="2.0" />'
    )

    const applied = applyVersionFixes(dir, [
      { name: 'Pkg.One', version: '1.5', file: 'a/A.csproj' },
      { name: 'Pkg.One', version: '1.5', file: 'b/B.csproj' },
      { name: 'Pkg.Two', version: '2.5.1', file: 'b/B.csproj' }
    ])

    expect(read('a/A.csproj')).toContain('Version="1.5"')
    expect(read('b/B.csproj')).toBe(
      '<PackageReference Include="Pkg.One" Version="1.5" />\n<PackageReference Include="Pkg.Two" Version="2.5.1" />'
    )
    expect(applied.map((a: any) => `${a.name}:${a.from}->${a.to}`)).toEqual([
      'Pkg.One:1.0->1.5',
      'Pkg.One:1.1->1.5',
      'Pkg.Two:2.0->2.5.1'
    ])
  })

  test('keeps BOM and CRLF byte for byte', () => {
    const original =
      '\uFEFF<Project>\r\n  <PackageReference Include="Umbraco.Cms" Version="17.7.1" />\r\n</Project>\r\n'
    write('a.csproj', original)

    applyVersionFixes(dir, [fix({ file: 'a.csproj' })])

    const bytes = actualFs.readFileSync(path.join(dir, 'a.csproj'))
    expect(bytes.toString('utf8')).toBe(original.replace('17.7.1', '17.7.2'))
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })

  test('does nothing when the version already matches', () => {
    write(
      'a.csproj',
      '<PackageReference Include="Umbraco.Cms" Version="17.7.2" />'
    )
    const before = actualFs.statSync(path.join(dir, 'a.csproj')).mtimeMs

    const applied = applyVersionFixes(dir, [fix({ file: 'a.csproj' })])

    expect(applied).toEqual([])
    expect(core.warning).not.toHaveBeenCalled()
    expect(actualFs.statSync(path.join(dir, 'a.csproj')).mtimeMs).toBe(before)
  })

  test('supports PackageVersion tags and props/targets files', () => {
    write(
      'Directory.Packages.props',
      '<PackageVersion Include="Umbraco.Cms" Version="17.7.1" />'
    )
    write(
      'x.targets',
      '<PackageReference Include="Umbraco.Cms" Version="17.7.1" />'
    )

    const applied = applyVersionFixes(dir, [
      fix({ file: 'Directory.Packages.props' }),
      fix({ file: 'x.targets' })
    ])

    expect(applied).toHaveLength(2)
    expect(read('Directory.Packages.props')).toContain('Version="17.7.2"')
    expect(read('x.targets')).toContain('Version="17.7.2"')
  })

  test('warns when the reference has no Version attribute', () => {
    const content =
      '<PackageReference Include="Umbraco.Cms">\n  <Version>17.7.1</Version>\n</PackageReference>'
    write('a.csproj', content)

    const applied = applyVersionFixes(dir, [fix({ file: 'a.csproj' })])

    expect(applied).toEqual([])
    expect(read('a.csproj')).toBe(content)
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not find a PackageReference')
    )
  })

  test('warns and continues when the package is not in the file', () => {
    write('a.csproj', '<PackageReference Update="Umbraco.Cms" Version="1" />')

    expect(applyVersionFixes(dir, [fix({ file: 'a.csproj' })])).toEqual([])
    expect(core.warning).toHaveBeenCalledTimes(1)
  })

  test('warns and continues when the file does not exist', () => {
    write(
      'b.csproj',
      '<PackageReference Include="Umbraco.Cms" Version="1.0" />'
    )

    const applied = applyVersionFixes(dir, [
      fix({ file: 'missing.csproj' }),
      fix({ file: 'b.csproj' })
    ])

    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('file does not exist')
    )
    expect(applied).toHaveLength(1)
  })

  test.each([
    ['../x.csproj'],
    ['src/../../x.csproj'],
    ['src/../x.csproj'],
    ['..\\x.csproj'],
    ['/etc/x.csproj'],
    ['\\\\server\\share\\x.csproj'],
    ['C:/x.csproj'],
    ['C:\\x.csproj'],
    ['src/x.txt'],
    ['src/x.csproj.bak'],
    ['']
  ])('rejects the file path %j', (file) => {
    write(
      'x.csproj',
      '<PackageReference Include="Umbraco.Cms" Version="1.0" />'
    )

    const applied = applyVersionFixes(dir, [fix({ file })])

    expect(applied).toEqual([])
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(read('x.csproj')).toContain('Version="1.0"')
  })

  test('accepts backslash separators inside the repository', () => {
    write(
      'src/x.csproj',
      '<PackageReference Include="Umbraco.Cms" Version="1.0" />'
    )

    const applied = applyVersionFixes(dir, [fix({ file: 'src\\x.csproj' })])

    expect(applied).toHaveLength(1)
    expect(read('src/x.csproj')).toContain('Version="17.7.2"')
  })

  test.each([
    [{ name: '' }],
    [{ name: '-bad' }],
    [{ name: 'Bad Name' }],
    [{ name: 'a"b' }],
    [{ version: '' }],
    [{ version: '17' }],
    [{ version: '17.7.2" Evil="1' }],
    [{ version: '1.2.3.4.5' }],
    [{ version: 'latest' }]
  ])('rejects invalid input %j', (over) => {
    write(
      'a.csproj',
      '<PackageReference Include="Umbraco.Cms" Version="1.0" />'
    )

    const applied = applyVersionFixes(dir, [fix({ file: 'a.csproj', ...over })])

    expect(applied).toEqual([])
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(read('a.csproj')).toContain('Version="1.0"')
  })

  test.each([
    ['17.7.2'],
    ['1.0'],
    ['1.2.3.4'],
    ['17.0.0-rc.1'],
    ['1.0.0+build.5'],
    ['1.0.0-beta+x']
  ])('accepts version %s', (version) => {
    write(
      'a.csproj',
      '<PackageReference Include="Umbraco.Cms" Version="0.1" />'
    )

    expect(
      applyVersionFixes(dir, [fix({ file: 'a.csproj', version })])
    ).toHaveLength(1)
    expect(read('a.csproj')).toContain(`Version="${version}"`)
  })

  test('refuses symlinks', () => {
    write(
      'a.csproj',
      '<PackageReference Include="Umbraco.Cms" Version="1.0" />'
    )
    mockLstat.mockImplementationOnce(
      () => ({ isSymbolicLink: () => true }) as actualFs.Stats
    )

    const applied = applyVersionFixes(dir, [fix({ file: 'a.csproj' })])

    expect(applied).toEqual([])
    expect(core.warning).toHaveBeenCalledWith(
      expect.stringContaining('symlink')
    )
    expect(read('a.csproj')).toContain('Version="1.0"')
  })
})
