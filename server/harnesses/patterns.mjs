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

/**
 * The sandbox family (SANDBOX_RESEARCH.md §7.12.1) — what a WALL looks like from
 * inside the agent's terminal, as opposed to what the proxy sees.
 *
 * It is deliberately not a per-harness set: a read-only filesystem, a tmpfs that
 * ran full and a daemon socket that is not there answer with the kernel's own
 * words whatever CLI ran into them. `detect.mjs` applies these ONLY to a
 * sandboxed run — an unsandboxed one hitting EACCES has an ordinary permission
 * problem, and calling that a sandbox denial would be a lie in the data.
 *
 * Every entry needs the errno (or the kernel phrase) PLUS the shape real output
 * has around it — a colon and its message, `code EACCES`, `connect ENETUNREACH`.
 * A bare token would fire on this file, on SANDBOX_RESEARCH.md and on the test
 * that pins these patterns, which is the failure this repo has already paid for
 * twice ("Upgrade to Max for higher rate limits", `555 tokens`). The rest of that
 * defence is the exception list in detect.mjs.
 *
 * `sandbox.proxy.denied` is matched through the two halves an agent can act on —
 * the refusal and the instruction — and never through the word "Freilauf", which
 * every copy of that string in this repository carries too.
 */
export const SANDBOX_PATTERNS = [
  // EACCES: node, python and go all print the code next to its own message.
  { typ: 'sandbox_denied', re: /\bEACCES\b\s*[:,]|\bcode\s+['"]?EACCES\b|\bpermission denied\b[^\n]{0,30}\bEACCES\b/ },
  // EROFS — the read-only root and the read-only .git mount.
  { typ: 'sandbox_denied', re: /\bEROFS\b\s*[:,]|\bcode\s+['"]?EROFS\b|:\s*read-only file system\b|\bread-only file system\s*$/i },
  // ENOSPC — a tmpfs that ran out, which looks like a full disk to the agent.
  { typ: 'sandbox_denied', re: /\bENOSPC\b\s*[:,]|\bcode\s+['"]?ENOSPC\b|\bno space left on device\b/i },
  // Docker-in-docker: the socket is deliberately not in the container.
  { typ: 'sandbox_denied', re: /\bcannot connect to the docker daemon\b/i },
  // DNS died at the proxy, or there is no resolver at all.
  { typ: 'sandbox_denied', re: /\bcould not resolve host\s*:\s*\S/i },
  // No route at all — `network.mode: 'none'`, or an address outside the bridge.
  { typ: 'sandbox_denied', re: /\bconnect\s+ENETUNREACH\b|\bENETUNREACH\b\s*[:,]|\bnetwork is unreachable\b/i },
  // The built-in proxy's own 403 body (server/sandbox/proxy.mjs, deniedBody):
  // the refusal and the instruction have to stand in ONE line, which is what
  // that body is and what no prose about it is.
  { typ: 'sandbox_denied', re: /\bis not reachable from this run\b[^\n]{0,200}\bfl-report access\b/i },
]
