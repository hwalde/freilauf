// cc-hub — kleine HTTP-Helfer, die pages.mjs und web.mjs teilen.
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
 * Formulardaten als flaches Objekt. Mehrfach vorkommende Felder (Checkbox-Gruppen wie
 * die Wochentage) gingen mit Object.fromEntries() bis auf den letzten Wert verloren —
 * sie stehen deshalb zusätzlich als Liste unter "<name>_list".
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

export function formBodyFactory(req) {
  return async () => parseForm(await body(req))
}
