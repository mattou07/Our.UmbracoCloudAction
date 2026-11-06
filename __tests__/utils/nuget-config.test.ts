import { jest } from '@jest/globals'
import * as xml2js from 'xml2js'

jest.unstable_mockModule('@actions/core', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  warning: jest.fn(),
  error: jest.fn()
}))

type AddEntry = { $: { key: string; value: string } }

describe('nuget-config', () => {
  let core: typeof import('@actions/core')
  let addOrUpdateNuGetConfigSource: typeof import('../../src/utils/nuget-config.js').addOrUpdateNuGetConfigSource
  let encodeXmlLocalName: typeof import('../../src/utils/nuget-config.js').encodeXmlLocalName

  beforeAll(async () => {
    core = await import('@actions/core')
    const mod = await import('../../src/utils/nuget-config.js')
    addOrUpdateNuGetConfigSource = mod.addOrUpdateNuGetConfigSource
    encodeXmlLocalName = mod.encodeXmlLocalName
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  async function parse(xml: string): Promise<any> {
    return xml2js.parseStringPromise(xml)
  }

  function sourcesOf(parsed: any): Record<string, string> {
    const adds: AddEntry[] = parsed.configuration.packageSources[0].add
    return Object.fromEntries(adds.map((a) => [a.$.key, a.$.value]))
  }

  function credentialsOf(
    parsed: any,
    elementName: string
  ): Record<string, string> {
    const adds: AddEntry[] =
      parsed.configuration.packageSourceCredentials[0][elementName][0].add
    return Object.fromEntries(adds.map((a) => [a.$.key, a.$.value]))
  }

  const existingConfig = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
    <add key="MyFeed" value="https://old.example.com/index.json" />
  </packageSources>
  <activePackageSource>
    <add key="All" value="(Aggregate source)" />
  </activePackageSource>
  <packageSourceMapping>
    <packageSource key="nuget.org">
      <package pattern="*" />
    </packageSource>
  </packageSourceMapping>
  <packageSourceCredentials>
    <MyFeed>
      <add key="Username" value="olduser" />
      <add key="ClearTextPassword" value="%OLD_PASSWORD%" />
    </MyFeed>
    <Other>
      <add key="Username" value="other" />
    </Other>
  </packageSourceCredentials>
</configuration>`

  test('creates a new config when no existing content is provided', async () => {
    const result = await addOrUpdateNuGetConfigSource({
      name: 'MyFeed',
      source: 'https://nuget.example.com/v3/index.json'
    })

    expect(result.success).toBe(true)
    expect(result.message).toContain('Created new NuGet.config')
    expect(result).not.toHaveProperty('nugetConfigPath')
    expect(result.xmlContent).toMatch(
      /^<\?xml version="1.0" encoding="utf-8"\?>/
    )

    const parsed = await parse(result.xmlContent)
    expect(sourcesOf(parsed)).toEqual({
      MyFeed: 'https://nuget.example.com/v3/index.json'
    })
    expect(parsed.configuration.packageSourceCredentials).toBeUndefined()
  })

  test('treats whitespace-only content as a new config', async () => {
    const result = await addOrUpdateNuGetConfigSource(
      { name: 'MyFeed', source: 'https://a' },
      '   \n'
    )
    expect(result.message).toContain('Created new NuGet.config')
  })

  test('preserves existing sources when adding a new one', async () => {
    const result = await addOrUpdateNuGetConfigSource(
      { name: 'NewFeed', source: 'https://new.example.com/index.json' },
      existingConfig
    )

    expect(result.message).toContain('Updated NuGet.config')
    const parsed = await parse(result.xmlContent)
    expect(sourcesOf(parsed)).toEqual({
      'nuget.org': 'https://api.nuget.org/v3/index.json',
      MyFeed: 'https://old.example.com/index.json',
      NewFeed: 'https://new.example.com/index.json'
    })
    // Extra attributes and <clear/> are preserved
    expect(result.xmlContent).toContain('protocolVersion="3"')
    expect(parsed.configuration.packageSources[0].clear).toBeDefined()
  })

  test('updates the URL of an existing source', async () => {
    const result = await addOrUpdateNuGetConfigSource(
      { name: 'MyFeed', source: 'https://new.example.com/index.json' },
      existingConfig
    )

    const parsed = await parse(result.xmlContent)
    const sources = sourcesOf(parsed)
    expect(sources.MyFeed).toBe('https://new.example.com/index.json')
    expect(Object.keys(sources)).toEqual(['nuget.org', 'MyFeed'])
  })

  test('adds credentials for a new source', async () => {
    const result = await addOrUpdateNuGetConfigSource({
      name: 'MyFeed',
      source: 'https://a',
      username: 'user',
      password: '%NUGET_PASSWORD%'
    })

    const parsed = await parse(result.xmlContent)
    expect(credentialsOf(parsed, 'MyFeed')).toEqual({
      Username: 'user',
      ClearTextPassword: '%NUGET_PASSWORD%'
    })
  })

  test('updates existing credentials without duplicating entries', async () => {
    const result = await addOrUpdateNuGetConfigSource(
      {
        name: 'MyFeed',
        source: 'https://a',
        username: 'newuser',
        password: '%NEW_PASSWORD%'
      },
      existingConfig
    )

    const parsed = await parse(result.xmlContent)
    const adds: AddEntry[] =
      parsed.configuration.packageSourceCredentials[0].MyFeed[0].add
    expect(adds).toHaveLength(2)
    expect(credentialsOf(parsed, 'MyFeed')).toEqual({
      Username: 'newuser',
      ClearTextPassword: '%NEW_PASSWORD%'
    })
    // Other credentials untouched
    expect(credentialsOf(parsed, 'Other')).toEqual({ Username: 'other' })
  })

  test('does not add credentials when only username is provided', async () => {
    const result = await addOrUpdateNuGetConfigSource({
      name: 'MyFeed',
      source: 'https://a',
      username: 'user'
    })
    const parsed = await parse(result.xmlContent)
    expect(parsed.configuration.packageSourceCredentials).toBeUndefined()
  })

  test('preserves other sections', async () => {
    const result = await addOrUpdateNuGetConfigSource(
      { name: 'NewFeed', source: 'https://new' },
      existingConfig
    )

    const parsed = await parse(result.xmlContent)
    expect(parsed.configuration.activePackageSource[0].add[0].$).toEqual({
      key: 'All',
      value: '(Aggregate source)'
    })
    expect(
      parsed.configuration.packageSourceMapping[0].packageSource[0].$.key
    ).toBe('nuget.org')
    expect(
      parsed.configuration.packageSourceMapping[0].packageSource[0].package[0].$
        .pattern
    ).toBe('*')
  })

  test('adds packageSources when the existing config has none', async () => {
    const result = await addOrUpdateNuGetConfigSource(
      { name: 'MyFeed', source: 'https://a' },
      '<configuration><config><add key="x" value="y"/></config></configuration>'
    )
    const parsed = await parse(result.xmlContent)
    expect(sourcesOf(parsed)).toEqual({ MyFeed: 'https://a' })
    expect(parsed.configuration.config[0].add[0].$.key).toBe('x')
  })

  test('handles an empty <configuration/> element', async () => {
    const result = await addOrUpdateNuGetConfigSource(
      { name: 'MyFeed', source: 'https://a' },
      '<configuration/>'
    )
    const parsed = await parse(result.xmlContent)
    expect(sourcesOf(parsed)).toEqual({ MyFeed: 'https://a' })
  })

  test('encodes a source name with a space in the credentials element', async () => {
    const result = await addOrUpdateNuGetConfigSource({
      name: 'My Feed',
      source: 'https://a',
      username: 'user',
      password: '%PW%'
    })

    expect(result.xmlContent).toContain('<My_x0020_Feed>')
    const parsed = await parse(result.xmlContent)
    // Source key itself is not encoded
    expect(sourcesOf(parsed)).toEqual({ 'My Feed': 'https://a' })
    expect(credentialsOf(parsed, 'My_x0020_Feed')).toEqual({
      Username: 'user',
      ClearTextPassword: '%PW%'
    })
  })

  test('matches existing credentials on the encoded name', async () => {
    const existing = `<configuration>
  <packageSources><add key="My Feed" value="https://old"/></packageSources>
  <packageSourceCredentials>
    <My_x0020_Feed>
      <add key="Username" value="old"/>
      <add key="ClearTextPassword" value="%OLD%"/>
    </My_x0020_Feed>
  </packageSourceCredentials>
</configuration>`
    const result = await addOrUpdateNuGetConfigSource(
      {
        name: 'My Feed',
        source: 'https://new',
        username: 'new',
        password: '%NEW%'
      },
      existing
    )
    const parsed = await parse(result.xmlContent)
    expect(
      Object.keys(parsed.configuration.packageSourceCredentials[0])
    ).toEqual(['My_x0020_Feed'])
    expect(credentialsOf(parsed, 'My_x0020_Feed')).toEqual({
      Username: 'new',
      ClearTextPassword: '%NEW%'
    })
  })

  test('encodeXmlLocalName follows XmlConvert.EncodeLocalName rules', () => {
    expect(encodeXmlLocalName('MyFeed')).toBe('MyFeed')
    expect(encodeXmlLocalName('My Feed')).toBe('My_x0020_Feed')
    expect(encodeXmlLocalName('1Feed')).toBe('_x0031_Feed')
    expect(encodeXmlLocalName('Feed1')).toBe('Feed1')
    expect(encodeXmlLocalName('my.feed-name')).toBe('my.feed-name')
    expect(encodeXmlLocalName('a:b')).toBe('a_x003A_b')
    expect(encodeXmlLocalName('a@b')).toBe('a_x0040_b')
    expect(encodeXmlLocalName('a_x0020_b')).toBe('a_x005F_x0020_b')
  })

  test('warns when a literal clear-text password is provided', async () => {
    await addOrUpdateNuGetConfigSource({
      name: 'MyFeed',
      source: 'https://a',
      username: 'user',
      password: 'hunter2'
    })
    expect(core.warning).toHaveBeenCalledTimes(1)
    const message = (core.warning as jest.Mock).mock.calls[0][0] as string
    expect(message).toContain('Umbraco Cloud git repository')
    expect(message).toContain('%SECRET_NAME%')
    expect(message).not.toContain('hunter2')
  })

  test('does not warn when the password is an environment variable reference', async () => {
    await addOrUpdateNuGetConfigSource({
      name: 'MyFeed',
      source: 'https://a',
      username: 'user',
      password: '%NUGET_PASSWORD%'
    })
    expect(core.warning).not.toHaveBeenCalled()
  })

  test('never logs the password', async () => {
    await addOrUpdateNuGetConfigSource({
      name: 'MyFeed',
      source: 'https://a',
      username: 'user',
      password: 'hunter2'
    })
    const logged = [
      ...(core.info as jest.Mock).mock.calls,
      ...(core.debug as jest.Mock).mock.calls
    ]
      .flat()
      .join('\n')
    expect(logged).not.toContain('hunter2')
  })

  test('rejects malformed XML', async () => {
    await expect(
      addOrUpdateNuGetConfigSource(
        { name: 'MyFeed', source: 'https://a' },
        '<configuration><packageSources>'
      )
    ).rejects.toThrow()
  })

  test('rejects XML without a configuration root', async () => {
    await expect(
      addOrUpdateNuGetConfigSource(
        { name: 'MyFeed', source: 'https://a' },
        '<settings/>'
      )
    ).rejects.toThrow('<configuration>')
  })
})
