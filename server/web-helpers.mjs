// cc-hub — small HTTP helpers shared by pages.mjs and web.mjs.
export function redirect(res, loc) {
  res.writeHead(303, { location: loc }).end()
}

export function body(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 1_000_000) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/**
 * Form data as a flat object. Fields occurring multiple times (checkbox groups like
 * the weekdays) would be lost down to the last value with Object.fromEntries() —
 * they are therefore additionally available as a list under "<name>_list".
 */
export function parseForm(text) {
  const params = new URLSearchParams(text)
  const out = {}
  for (const key of new Set(params.keys())) {
    const alle = params.getAll(key)
    out[key] = alle[alle.length - 1]
    out[`${key}_list`] = alle
  }
  return out
}

// ---------------- the repo choice cookie ----------------
// The repo selected in the header is remembered in a cookie, so navigation to a
// page that carries no ?repo= itself keeps the choice instead of falling back to
// the first repo. The client writes it when the switcher changes; the server
// (re-)writes it whenever a page request arrives with a valid ?repo=, so a URL
// someone followed also becomes the persisted choice.

const REPO_COOKIE = 'cchub_repo'

/** The repo id stored in the cchub_repo cookie, or null. */
export function cookieRepo(req) {
  const m = /(?:^|;\s*)cchub_repo=(\d+)(?:;|$)/.exec(req.headers.cookie ?? '')
  return m ? Number(m[1]) : null
}

/** Remember the chosen repo in the browser for a year (until the user changes it). */
export function rememberRepo(res, id) {
  res.setHeader('set-cookie', `${REPO_COOKIE}=${id}; Path=/; Max-Age=31536000; SameSite=Lax`)
}
