// cc-hub — OpenRouter best-provider selection (pure logic).
//
// Ported in spirit from the measured algorithm of ~/projects/internal-project
// (orchestrators/shared-scripts/llm_client.py + modell_preflight.py), generalized
// from its fixed "fp8" policy to a configurable one. This file imports NOTHING of
// the hub — a built-in plugin file may not import db.mjs / i18n.mjs
// (docs/plugins.md, "What a plugin may import") — so it is unit-testable as is
// and safely imported by both the provider plugin and server code.
//
// The decision rule (same shape as the internal-project PO decision of
// 2026-08-19, generalized):
//
//   eligible := quantization KNOWN (null/unknown never counts as a level)
//             ∧ quantization at least `quant_min` when one is set
//               — "fp8 or better", never an enumeration the future can age out
//             ∧ provider healthy (status >= 0, uptime ≥ 90 % when reported)
//             ∧ region matches `location` when one is set (unknown → out,
//               same conservative direction as the quantization rule)
//             ∧ prices within the caps (USD per Mio tokens)
//   ranked   := no quant_min → the BEST quantization's endpoints, cheapest first
//               (the ask is "best quantization from a reliable provider", not
//               "cheapest, whatever precision that costs")
//               quant_min set → every qualifying endpoint, cheapest first
//             → order = their tags, up to `depth` of them: cheapest first, but
//               with reachable fallbacks behind it (a one-name list is the
//               failure mode that cost internal-project a whole run: one 429
//               and nothing was left).

// ── The quantization order ────────────────────────────────────────────────────
//
// The rank is effective numeric precision, coarsest first (ported from
// `_QUANT_RANG`). Ties are deliberate: fp16 and bf16 are both 16 bits — for a
// lower bound "at least as precise as fp8" both qualify. int8 sits BELOW fp8:
// both are 8 bits, but which representation is the more exact one depends on
// the method, and the safe direction of a lower bound is to exclude.
//
// Beyond the OpenRouter catalog values this deliberately accepts a WIDE family
// of spellings (fp5, q4, q4_K_M, nf4, awq, gptq, mxfp6, int4, 8-bit …): the
// parser below normalizes them onto the same scale, so a requirement typed as
// "q4" and an endpoint reporting "int4" meet on equal footing. A level the
// parser cannot read is UNKNOWN — it is excluded under a quantization
// requirement, never silently let through, and `unknownQuantizations()` names
// what the order table would need added.
// Beyond the OpenRouter catalog values this deliberately accepts a WIDE family
// of spellings (fp5, q4, q4_K_M, nf4, awq, gptq, mxfp6, int4, 8-bit …): the
// parser below normalizes them onto the same scale, so a requirement typed as
// "q4" and an endpoint reporting "int4" meet on equal footing. A level the
// parser cannot read is UNKNOWN — it is excluded under a quantization
// requirement, never silently let through, and `unknownQuantizations()` names
// what the parser would need added.
//
// The KNOWN list is the form's option set AND the gap detector — it names the
// values an operator may reasonably type, not the full scale (the parser
// accepts more than it lists).

/** Values that explicitly mean "no information" — never a level, never an error. */
const QUANT_UNSET = new Set([null, undefined, '', 'unknown', 'null', 'none', '—', '-'])

/**
 * One quantization spelling → `{ bits, kind, rank }`, or null when it means
 * "no information". Accepts the catalog's own values (fp8, mxfp4, int4, bf16)
 * and the wider family the operator may type: q4/q4_K_M (GGUF), nf4, awq,
 * gptq, fp5, fp6, int8, "8 bit", "4-bit". The rank is the only thing the
 * comparison ever reads — parsing may grow, the scale does not drift.
 *
 * Rank = effective numeric precision, `bits * 10` plus a format correction:
 * mxfp ranks just above plain fp of the same width (block scaling buys some
 * precision back); int/q ranks BELOW fp of the same width — both are N bits,
 * but which of the two representations is the exact one depends on the method,
 * and the safe direction of a lower bound is to exclude. fp16 and bf16 tie by
 * construction: both are 16 bits, for a lower bound "at least as precise as
 * fp8" both qualify.
 */
export function parseQuantization(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (!s || QUANT_UNSET.has(s)) return null
  // mxfp<n> — microscaling formats
  let m = s.match(/^mxfp(\d+)$/)
  if (m) return withRank(+m[1], 'mxfp')
  // fp<n> / bf<n>
  m = s.match(/^(fp|bf)(\d+)$/)
  if (m) return withRank(+m[2], m[1])
  // int<n> / q<n> / q<n><suffixes> (q4_k_m, q5_1 …) — llama.cpp-style quantizations
  m = s.match(/^(?:int|q)(\d+)/)
  if (m) return withRank(+m[1], 'int')
  // nf4 / awq / gptq / gguf — the common 4-bit weight-only families.
  if (/^(nf4|awq|gptq|gguf)/.test(s)) return withRank(4, 'int')
  // "<n> bit" / "<n>bit"
  m = s.match(/^(\d+)bit$/)
  if (m) return withRank(+m[1], 'fp')
  return null
}

function withRank(bits, kind) {
  return { bits, kind, rank: (bits * 10) + (kind === 'mxfp' ? 5 : kind === 'int' ? -5 : 0) }
}

/** The spellings the parser knows by name — the form's select options. */
export const KNOWN_QUANTIZATIONS = [
  'fp4', 'int4', 'q4', 'nf4', 'mxfp4', 'fp5', 'fp6', 'int8', 'fp8', 'fp16', 'bf16', 'fp32',
]

/** All levels at least as precise as `min` — the "or better" enumeration. */
export function quantizationsFrom(min) {
  const lo = parseQuantization(min)
  if (!min || !String(min).trim() || QUANT_UNSET.has(String(min).trim().toLowerCase())) {
    return [...KNOWN_QUANTIZATIONS]
  }
  if (!lo) {
    throw new Error(`unknown minimum quantization ${JSON.stringify(min)} — known: ${KNOWN_QUANTIZATIONS.join(', ')}`)
  }
  return KNOWN_QUANTIZATIONS.filter(q => parseQuantization(q).rank >= lo.rank)
}

/** Which of the given values does the parser NOT know? (the loud gap) */
export function unknownQuantizations(values) {
  return [...new Set((values ?? [])
    .filter(v => !QUANT_UNSET.has(String(v ?? '').trim().toLowerCase()))
    .map(v => String(v).trim().toLowerCase())
    .filter(v => !parseQuantization(v)))]
}

// ── Regions ───────────────────────────────────────────────────────────────────
//
// The endpoints API names NO region, so the location filter reads it from the
// provider's name/tag. The map is deliberately CONSERVATIVE: a provider that
// matches no rule is "unknown location" and is dropped when a location is
// required — the same direction as the quantization rule (unknown never
// qualifies). Extend REGION_PATTERNS, never guess: a wrong region silently
// removes or admits a provider, and neither is visible in a run.

const REGION_PATTERNS = [
  ['de', /(^|[^a-z])(de|germany|deutschland|mancer|tng)([^a-z]|$)/],
  ['eu', /(^|[^a-z])(eu|europe|european|france|netherlands|sweden|poland|czech|austria|ireland|finland|denmark|belgium|spain|italy|portugal|ireland|lithuania|estonia|latvia|slovenia|croatia)([^a-z]|$)/],
  ['cn', /(^|[^a-z])(china|chinese|\bcn\b|beijing|shenzhen|shanghai|hangzhou|baidu|moonshot|alibaba|qwen|minimax|z\.?ai|zhipu|siliconflow|tencent|volcengine|bytedance|deepseek|xiaomi|io-net|stepfun|01\.ai|yi-?(?:lightning|large)?|hunyuan|doubao)([^a-z]|$)/],
  ['us', /(^|[^a-z])(us|usa|america|united.?states|virginia|texas|california|oregon|ohio)([^a-z]|$)/],
]

/**
 * Which region does a provider name or tag suggest? `null` = no evidence —
 * the honest answer, and the one a location requirement treats as "out".
 */
export function regionOf(...names) {
  const hay = names.filter(Boolean).join(' ').toLowerCase()
  for (const [region, re] of REGION_PATTERNS) if (re.test(hay)) return region
  return null
}

// ── The config the operator sets ──────────────────────────────────────────────

export const REGIONS = ['all', 'us', 'eu', 'de', 'cn']

/**
 * Form fields / stored blob → a normalized routing config, or null (no routing
 * wanted). Unknown keys dropped, numbers coerced, a nonsense minimum is a
 * problem the caller reports — never silently "no filter".
 *
 * Shape: `{ mode:'auto', quant_min?, location?, max_in?, max_out? }` —
 * `quant_min: null` means "best available quantization from a healthy provider",
 * a price cap left empty means "no cap".
 */
export function parseRoutingConfig(input = {}) {
  // An explicitly different mode is not an auto config — null, not an error:
  // the caller decides what "no routing" means (the pin, the open default).
  if (input?.mode && input.mode !== 'auto') return null
  const cfg = { mode: 'auto' }
  const quant = String(input.quant_min ?? '').trim()
  if (quant && !QUANT_UNSET.has(quant.toLowerCase())) {
    if (!parseQuantization(quant)) return { mode: 'auto', error: `unknown quantization ${quant}` }
    cfg.quant_min = quant.trim().toLowerCase()
  }
  const loc = String(input.location ?? 'all').trim().toLowerCase()
  cfg.location = REGIONS.includes(loc) ? loc : 'all'
  for (const [key, raw] of [['max_in', input.max_in], ['max_out', input.max_out]]) {
    const n = Number(String(raw ?? '').trim())
    if (raw != null && String(raw).trim() !== '' && Number.isFinite(n) && n > 0) cfg[key] = n
  }
  return cfg
}

/** Two configs demand the same answer? (the cache key's meaningful half) */
export function routingConfigKey(cfg) {
  if (!cfg || cfg.mode !== 'auto') return null
  return JSON.stringify({
    q: cfg.quant_min ?? null,
    r: cfg.location ?? 'all',
    in: cfg.max_in ?? null,
    out: cfg.max_out ?? null,
  })
}

// ── The selection ─────────────────────────────────────────────────────────────


/** Per-token price string → USD per million tokens, or null. */
const perMio = (p) => {
  const n = Number(p)
  return Number.isFinite(n) ? Math.round(n * 1_000_000 * 1e6) / 1e6 : null
}

/**
 * One endpoint against the requirements — the pure half of the filter.
 * `locationOf` is injected so the caller decides how a name maps to a region
 * (and so a test can pin it).
 */
export function endpointFits(endpoint, cfg = {}, regionOfFn = regionOf) {
  cfg = cfg ?? {}
  const quant = parseQuantization(endpoint.quantization)
  const price = endpoint.pricing ?? {}
  const inUsd = perMio(price.prompt)
  const outUsd = perMio(price.completion)
  const wantMin = cfg.quant_min ? parseQuantization(cfg.quant_min) : null
  // Unknown quantization is NEVER a match — `null` means "no statement", not
  // "unquantized" (the measured fallstrick: it has silently routed to fp4 hosts).
  if (!quant) return { ok: false, reason: 'quantization unknown' }
  if (wantMin && quant.rank < wantMin.rank) {
    return { ok: false, reason: `quantization ${endpoint.quantization} below ${cfg.quant_min}` }
  }
  if (cfg.location && cfg.location !== 'all') {
    const r = regionOfFn(endpoint.provider_name, endpoint.tag)
    if (r !== cfg.location) return { ok: false, reason: `region ${r ?? 'unknown'} ≠ ${cfg.location}` }
  }
  if (cfg.max_in != null && inUsd != null && inUsd > cfg.max_in) {
    return { ok: false, reason: `input price ${inUsd} > ${cfg.max_in}` }
  }
  if (cfg.max_out != null && outUsd != null && outUsd > cfg.max_out) {
    return { ok: false, reason: `output price ${outUsd} > ${cfg.max_out}` }
  }
  return { ok: true, quant, inUsd, outUsd }
}

/**
 * The best-provider selection over one model's endpoint list.
 *
 * `endpoints` — the shape OpenRouter's `/models/<id>/endpoints` returns,
 * narrowed to what the decision reads (tag, provider_name, quantization,
 * status, uptime_last_30m, pricing).
 *
 * Returns `{ ok, order, best, quant, dropped, reason? }`. `order` is the list
 * of tags for OpenRouter's `provider.order` (cheapest healthy first, up to
 * `depth`), `best` its first entry, `dropped` the endpoints that fell out WITH
 * their reason — a filter that silently removes a provider is how one spends
 * days trusting a selection nobody can audit.
 */
export function selectBestProvider(endpoints, cfg = {}, { depth = 4, regionOf: regionOfFn } = {}) {
  cfg = cfg ?? {}
  const dropped = []
  const endpunkte = (endpoints ?? []).filter(e => e?.tag)
  if (!endpunkte.length) {
    return { ok: false, order: [], best: null, quant: null, dropped, reason: 'no endpoints reported' }
  }

  const healthy = endpunkte.filter(ep => {
    // status: OpenRouter's own verdict. 0 = healthy; a NEGATIVE status is a
    // degradation report (measured: -2/-5 exactly on the providers that failed
    // in production) — excluded, not trusted, not averaged away.
    if (Number.isFinite(ep.status) && ep.status < 0) {
      dropped.push({ tag: ep.tag, reason: `degraded (status ${ep.status})` })
      return false
    }
    const up = Number(ep.uptime_last_30m)
    if (Number.isFinite(up) === false) { /* no measurement → no claim, stays in */ }
    else if (up < 90) {
      dropped.push({ tag: ep.tag, reason: `uptime ${Math.round(up)}% < 90%` })
      return false
    }
    if ((ep.supported_parameters ?? []).length &&
        !(ep.supported_parameters ?? []).includes('tools')) {
      // The hub's runs are coding agents: an endpoint that cannot take a
      // tool call is dead weight in the chain, whatever its price.
      dropped.push({ tag: ep.tag, reason: 'no tool support' })
      return false
    }
    const fit = endpointFits(ep, cfg, regionOfFn)
    if (!fit.ok) {
      dropped.push({ tag: ep.tag, reason: fit.reason })
      return false
    }
    ep._rank = fit.quant.rank
    ep._inUsd = fit.inUsd
    ep._outUsd = fit.outUsd
    return true
  })

  if (!healthy.length) {
    return { ok: false, order: [], best: null, quant: null, dropped,
             reason: dropped.length ? 'every endpoint filtered out' : 'no endpoints reported' }
  }

  // No minimum quantization: the requirement reads "the BEST quantization a
  // reliable provider serves" — so the pool narrows to the top rank before
  // price breaks the tie. With a minimum, everything at or above it competes
  // on price (fp8-or-better was always meant as a FLOOR, not a wish list).
  let pool = healthy
  if (!cfg.quant_min) {
    const top = Math.max(...pool.map(e => e._rank))
    pool = pool.filter(e => e._rank === top)
  }

  const priceOf = (e) => (e._inUsd ?? Infinity) + (e._outUsd ?? Infinity)
  const ordered = [...pool].sort((a, b) =>
    priceOf(a) - priceOf(b) ||
    (b._rank ?? 0) - (a._rank ?? 0) ||
    (b.uptime_last_30m ?? -1) - (a.uptime_last_30m ?? -1))
  const order = ordered.slice(0, depth).map(e => e.tag)
  return {
    ok: true,
    order,
    best: order[0] ?? null,
    quant: ordered[0]?.quantization ?? null,
    prices: ordered.slice(0, depth).map(e => ({ tag: e.tag, in_usd_mio: e._inUsd, out_usd_mio: e._outUsd })),
    dropped,
  }
}
