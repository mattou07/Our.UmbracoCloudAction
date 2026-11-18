/**
 * Umbraco Cloud API responses modelled on ones captured during end-to-end
 * runs against a live Cloud project. Project, host, package and deployment
 * names/IDs and SAS signatures are neutral placeholders; the wording and
 * structure are kept as Cloud sent them, including wording that differs from
 * the public docs.
 */

export const PROJECT_ID = '11111111-2222-4333-8444-555555555555'

/** Status messages, in the order Cloud emitted them, for failed deployments. */
export const STATUS_MESSAGES = {
  /** Artifact without a .umbraco file at the root (docs say "File missing: ...") */
  missingUmbracoFile: [
    'No changes to deploy - cleaning up',
    'Incoming package has no .umbraco file in its root. It names the project folder and project file the build uses.',
    'Deployment aaaaaaaa-0000-4000-8000-000000000004 failed'
  ],
  /** .umbraco whose base path doesn't exist in the artifact */
  invalidUmbracoBase: [
    'No changes to deploy - cleaning up',
    "Incoming package: the project base 'src/Contoso.Web' in the .umbraco file does not exist.",
    'Deployment aaaaaaaa-0000-4000-8000-000000000006 failed'
  ],
  /** Source references older Umbraco packages than Cloud runs */
  downgrade: [
    "Kept the Cloud environment's umbraco-cloud.json in place of the package's.",
    'No changes to deploy - cleaning up',
    'Cannot apply update because the following packages would be downgraded: Package: Umbraco.Cms, Version: 17.7.2 ==> Referencing file: src/Contoso.Web/Contoso.Web.csproj contains lower Version: 17.4.2 . Package: Umbraco.Cloud.StorageProviders.AzureBlob, Version: 17.1.0 ==> Referencing file: src/Contoso.Web/Contoso.Web.csproj contains lower Version: 17.0.0 . Package: Umbraco.Cloud.Cms, Version: 17.2.3 ==> Referencing file: src/Contoso.Web/Contoso.Web.csproj contains lower Version: 17.1.3 ',
    'Deployment aaaaaaaa-0000-4000-8000-000000000003 failed'
  ],
  /** Compile error caught by Cloud's isolated build (log only via signed link) */
  buildError: [
    'Git Commit',
    'NuGet Restore',
    'Dotnet Build',
    'Error building project. Build log: https://examplestorage.blob.core.windows.net/logs/aaaaaaaa-0000-4000-8000-000000000001/bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000001-DotnetBuild.txt?sv=2025-07-05&se=2027-02-04T16%3A29%3A22Z&sr=b&sp=r&sig=SYNTHETICbuild%2Bsig%3D',
    'Deployment aaaaaaaa-0000-4000-8000-000000000001 failed'
  ],
  /** Package that can't be resolved from any configured feed */
  restoreError: [
    'Git Commit',
    'NuGet Restore',
    'Error restoring packages. Restore log: https://examplestorage.blob.core.windows.net/logs/aaaaaaaa-0000-4000-8000-000000000002/bbbbbbbb-0000-4000-8000-000000000001/aaaaaaaa-0000-4000-8000-000000000002-NugetRestore.txt?sv=2025-07-05&se=2027-02-04T16%3A29%3A22Z&sr=b&sp=r&sig=SYNTHETICrestore%2Bsig%3D',
    'Deployment aaaaaaaa-0000-4000-8000-000000000002 failed'
  ],
  /**
   * noBuildAndRestore + compile error: Cloud pushed the commit to the Cloud
   * repo (cloudRepositoryUpdated: true), then Kudu's build failed.
   */
  kuduBuildFailedAfterPush: [
    'Git Commit',
    'Skipped : Nuget Restore',
    'Skipped : Dotnet Build',
    'Git Push',
    'Picking up Kudu Deployment stream',
    "    Restored C:\\home\\site\\repository\\src\\Contoso.Web\\Contoso.Web.csproj (in 8.38 sec).\n  C:\\home\\site\\repository\\src\\Contoso.Core\\Broken.cs(2,26): error CS1519: Invalid token 'this' in a member declaration [C:\\home\\site\\repository\\src\\Contoso.Core\\Contoso.Core.csproj]",
    '  Notifying kudu deployment script failed',
    'Verify Deployment',
    'KUDU: Deployment Failed',
    'KUDU deployment log id: 0123456789abcdef0123456789abcdef01234567',
    'Unable to verify Deployment has finished',
    'Deployment aaaaaaaa-0000-4000-8000-000000000005 failed'
  ]
}

/** Builds a DeploymentResponse-shaped object from a list of messages. */
export function failedDeployment(
  deploymentId: string,
  messages: string[],
  cloudRepositoryUpdated = false
) {
  return {
    deploymentId,
    projectId: PROJECT_ID,
    environmentAlias: 'live',
    deploymentState: 'Failed',
    deploymentStatusMessages: messages.map((message, i) => ({
      message,
      timestampUtc: `2026-11-06T17:00:${String(i).padStart(2, '0')}.000Z`
    })),
    createdUtc: '2026-11-06T17:00:00.000Z',
    completedUtc: null,
    modifiedUtc: `2026-11-06T17:00:${String(messages.length).padStart(2, '0')}.000Z`,
    cloudRepositoryUpdated
  }
}

/** Error response bodies as Cloud sent them. */
export const ERROR_BODIES = {
  /** API gateway format (invalid key) – note: not RFC problem details */
  invalidApiKey401: {
    statusCode: 401,
    message:
      'Access denied due to invalid subscription key. Make sure to provide a valid key for an active subscription.'
  },
  /** Valid key, wrong project – sent pretty-printed (multi-line) */
  wrongProject401Text:
    '{\n  "type": "https://tools.ietf.org/html/rfc7235#section-3.1",\n  "title": "Unauthorized",\n  "status": 401,\n  "detail": "Provided Umbraco-Cloud-Api-Key does not give access to manage specified projectId"\n}',
  unknownAlias400: {
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
    title: 'Invalid target environment',
    status: 400,
    detail: `Deployment for project ${PROJECT_ID} could not be created, reason: No environments matches the provided alias nope`
  },
  deploymentInProgress409: {
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.10',
    title: 'Invalid deployment state - different deployment in progress',
    status: 409,
    detail: `Deployment for project ${PROJECT_ID} could not be created, existing deployment in progress`,
    traceId: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-00'
  },
  cloudNullDeployment409: {
    type: 'CloudNullDeployment',
    title: 'Deployment did not make any changes to cloud',
    status: 409,
    detail:
      'Deployment aaaaaaaa-0000-4000-8000-000000000003 had no changes for cloud git repository. Try an older, completed deployment'
  },
  /** 270 MB upload; v2 limit is 268435456 bytes (256 MB) */
  artifactTooLarge400: {
    type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
    title: 'One or more validation errors occurred.',
    status: 400,
    errors: {
      '': [
        'Failed to read the request form. Multipart body length limit 268435456 exceeded.'
      ]
    },
    traceId: '00-fedcba9876543210fedcba9876543210-fedcba9876543210-00'
  },
  /** Gateway throttling (seen on status polling and the diff endpoint) */
  rateLimited429: {
    statusCode: 429,
    message: 'Rate limit is exceeded. Try again in 2 seconds.'
  }
}

/**
 * Representative excerpts of the signed logs Cloud links to. The line format
 * matches a real NuGet restore log from a Cloud deployment; the package
 * and file names come from the scenarios (the signed links were redacted in
 * the captured output, so the exact log bodies weren't kept).
 */
export const SIGNED_LOGS = {
  restore: [
    '  Determining projects to restore...',
    'O: /app/work/repository/src/Contoso.Web/Contoso.Web.csproj : error NU1101: Unable to find package Contoso.DoesNotExist. No packages exist with this id in source(s): fabrikam.github, northwind.github, nuget.org, contoso.github',
    '  Failed to restore /app/work/repository/src/Contoso.Web/Contoso.Web.csproj (in 2.1 sec).'
  ].join('\n'),
  build: [
    '  Determining projects to restore...',
    '  All projects are up-to-date for restore.',
    "/app/work/repository/src/Contoso.Core/Broken.cs(2,26): error CS1519: Invalid token 'this' in a member declaration [/app/work/repository/src/Contoso.Core/Contoso.Core.csproj]",
    '',
    'Build FAILED.',
    '    0 Warning(s)',
    '    1 Error(s)'
  ].join('\n')
}
