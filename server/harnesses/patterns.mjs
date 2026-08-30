// Freilauf — regex fragments shared by the log patterns of the coding-agent plugins.
//
// Lives here and not in detect.mjs because detect.mjs imports the plugin
// registry: the plugins must not import back from it.
//
// A bare three-digit number is NOT an HTTP status. cursor's own status line
//
//     ⠠⠛ Globbing  555 tokens
//
// opened a "Provider error" incident on a production run, because /\b5\d\d\b/
// matches a token count just as happily as a 503. A status code only counts
// when an error word stands next to it — which is how every harness actually
// prints one: "API Error: 503", "upstream connection error (502)",
// "500 Internal Server Error".
export const HTTP_5XX = /\b(?:api|http|error|status|code|response)\b[^\n]{0,16}\b5\d\d\b|\b5\d\d\b\s*[-–—:]?\s*(?:internal server error|bad gateway|service unavailable|gateway time-?out)/i
