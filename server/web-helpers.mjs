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
