export const REDACTED = '[redacted]'

// Any http(s) URL followed by a query string
const URL_WITH_QUERY_PATTERN = /(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>]*/gi
// A SAS-style signature parameter inside a query string
const SAS_SIGNATURE_PATTERN = /(^|[?&])sig=/i

/**
 * Strips the query string from any URL in the text that carries a `sig=`
 * signature (e.g. Azure SAS links to Cloud restore logs or artifacts), so the
 * link stays recognisable but can no longer be used to read the resource.
 */
export function redactSignedUrls(value: string): string {
  return value.replace(URL_WITH_QUERY_PATTERN, (match, base: string) => {
    const query = match.slice(base.length + 1)
    return SAS_SIGNATURE_PATTERN.test(query) ? `${base}?${REDACTED}` : match
  })
}
