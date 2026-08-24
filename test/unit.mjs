#!/usr/bin/env node
// cc-hub — Unit-Tests für die Funktionen mit echter Logik und Randfällen.
//
// Bewusst NICHT geprüft: SQL-Strings, HTML-Schnipsel, CSS-Klassen, Spaltenreihenfolgen,
// exakte Meldungstexte, private Hilfsfunktionen. Solche Tests würden nur die aktuelle
// Umsetzung einbetonieren, statt Verhalten abzusichern. Geprüft wird, was rechnet oder
// entscheidet — Zeitpläne, Cron, Formular-Parsing, Quota-Gate, Textaufbereitung.
//
// Aufruf:  node test/unit.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gruppe, pruefe, gleich, wahr, falsch, enthaelt, bericht, zaehler } from './mini.mjs'

const start = Date.now()

// Eigenes Datenverzeichnis: der Import von runner.mjs zieht db.mjs mit und würde sonst
// die echte Hub-Datenbank anfassen.
const sandkasten = mkdtempSync(join(tmpdir(), 'cc-hub-unit-'))
process.env.CCHUB_DATA_DIR = join(sandkasten, 'data')

const d = (s) => new Date(s)

try {
  const { cronMatches, validCron, scheduleDue, scheduleText, stripAnsi, escapeHtml,
    fmtDuration, kurzid } = await import('../server/util.mjs')
  const { parseForm } = await import('../server/web-helpers.mjs')

  // ------------------------------------------------------------------
  gruppe('Cron: Treffer (cronMatches)')

  await pruefe('feste Uhrzeit trifft genau die Minute', () => {
    wahr(cronMatches('30 6 * * *', d('2026-08-24T06:30:00')), '06:30')
    falsch(cronMatches('30 6 * * *', d('2026-08-24T06:31:00')), '06:31')
  })
  await pruefe('Schritte */15 treffen jede Viertelstunde', () => {
    for (const m of [0, 15, 30, 45]) wahr(cronMatches('*/15 * * * *', d(`2026-08-24T10:${String(m).padStart(2, '0')}:00`)), `Minute ${m}`)
    falsch(cronMatches('*/15 * * * *', d('2026-08-24T10:31:00')), 'Minute 31')
  })
  await pruefe('Bereich 1-5 meint Montag bis Freitag', () => {
    wahr(cronMatches('0 6 * * 1-5', d('2026-08-24T06:00:00')), 'Montag')
    wahr(cronMatches('0 6 * * 1-5', d('2026-08-28T06:00:00')), 'Freitag')
    falsch(cronMatches('0 6 * * 1-5', d('2026-08-23T06:00:00')), 'Sonntag')
  })
  await pruefe('Liste 1,3,5 trifft nur die genannten Tage', () => {
    wahr(cronMatches('0 6 * * 1,3,5', d('2026-08-26T06:00:00')), 'Mittwoch')
    falsch(cronMatches('0 6 * * 1,3,5', d('2026-08-25T06:00:00')), 'Dienstag')
  })
  await pruefe('Wochentag 7 bedeutet Sonntag (wie 0)', () => {
    wahr(cronMatches('0 6 * * 7', d('2026-08-23T06:00:00')), 'Sonntag als 7')
    wahr(cronMatches('0 6 * * 0', d('2026-08-23T06:00:00')), 'Sonntag als 0')
  })
  await pruefe('Monat und Tag werden mitgeprüft', () => {
    wahr(cronMatches('0 0 1 1 *', d('2027-01-01T00:00:00')), 'Neujahr')
    falsch(cronMatches('0 0 1 1 *', d('2026-12-31T00:00:00')), 'Silvester')
  })
  await pruefe('falsche Feldzahl trifft nie', () => {
    falsch(cronMatches('* * * *', d('2026-08-24T06:00:00')), 'vier Felder')
    falsch(cronMatches('', d('2026-08-24T06:00:00')), 'leer')
  })

  // ------------------------------------------------------------------
  gruppe('Cron: Eingabeprüfung (validCron)')

  await pruefe('übliche Ausdrücke gelten als gültig', () => {
    for (const c of ['0 6 * * *', '0 6 * * 1-5', '*/15 * * * *', '0 0 1 1 *', '30 6 * * 1,3,5'])
      wahr(validCron(c), c)
  })
  await pruefe('Müll und falsche Feldzahl werden abgelehnt', () => {
    for (const c of ['jeden tag', '* * * *', '* * * * * *', '', null, undefined, 'abc def ghi jkl mno'])
      falsch(validCron(c), String(c))
  })
  await pruefe('zu große Werte werden abgelehnt', () => {
    falsch(validCron('99 * * * *'), 'Minute 99')
    falsch(validCron('* 25 * * *'), 'Stunde 25')
    falsch(validCron('* * 32 * *'), 'Tag 32')
    falsch(validCron('* * * 13 *'), 'Monat 13')
  })
  await pruefe('unsinniger Bereich (5-1) wird abgelehnt', () => {
    falsch(validCron('0 6 * * 5-1'), 'absteigender Bereich')
  })

  // ------------------------------------------------------------------
  gruppe('Zeitpläne: Fälligkeit (scheduleDue)')

  const woe = { schedule_kind: 'woechentlich', schedule_days: '1,3,5', schedule_time: '07:30', schedule_weeks: 1 }

  await pruefe('wöchentlich: nur gewählte Tage zur gewählten Minute', () => {
    wahr(scheduleDue(woe, d('2026-08-24T07:30:00')), 'Montag 07:30')
    wahr(scheduleDue(woe, d('2026-08-26T07:30:00')), 'Mittwoch 07:30')
    falsch(scheduleDue(woe, d('2026-08-25T07:30:00')), 'Dienstag')
    falsch(scheduleDue(woe, d('2026-08-24T07:31:00')), 'eine Minute daneben')
    falsch(scheduleDue(woe, d('2026-08-23T07:30:00')), 'Sonntag')
  })

  const zwei = { ...woe, schedule_weeks: 2, schedule_anchor: '2026-08-24' }
  await pruefe('zweiwöchentlich: Ankerwoche ja, Folgewoche nein', () => {
    wahr(scheduleDue(zwei, d('2026-08-24T07:30:00')), 'Ankerwoche Montag')
    wahr(scheduleDue(zwei, d('2026-08-28T07:30:00')), 'Ankerwoche Freitag')
    falsch(scheduleDue(zwei, d('2026-08-31T07:30:00')), 'Folgewoche Montag')
    falsch(scheduleDue(zwei, d('2026-09-04T07:30:00')), 'Folgewoche Freitag')
    wahr(scheduleDue(zwei, d('2026-09-07T07:30:00')), 'übernächste Woche')
  })
  await pruefe('Takt zählt ganze Wochen, auch über Monats- und Jahresgrenze', () => {
    const ueberJahr = { ...woe, schedule_weeks: 2, schedule_anchor: '2026-12-28' }
    wahr(scheduleDue(ueberJahr, d('2026-12-28T07:30:00')), 'Ankerwoche (Dezember)')
    falsch(scheduleDue(ueberJahr, d('2027-01-04T07:30:00')), 'Folgewoche (Januar)')
    wahr(scheduleDue(ueberJahr, d('2027-01-11T07:30:00')), 'zwei Wochen später (Januar)')
  })
  await pruefe('drei- und vierwöchentlich treffen nur ihren Takt', () => {
    const drei = { ...zwei, schedule_weeks: 3 }
    const vier = { ...zwei, schedule_weeks: 4 }
    wahr(scheduleDue(drei, d('2026-09-14T07:30:00')), '+3 Wochen')
    falsch(scheduleDue(drei, d('2026-09-07T07:30:00')), '+2 Wochen')
    wahr(scheduleDue(vier, d('2026-09-21T07:30:00')), '+4 Wochen')
    falsch(scheduleDue(vier, d('2026-09-14T07:30:00')), '+3 Wochen')
  })
  await pruefe('Ankerwoche in der Zukunft ist nie fällig', () => {
    const kuenftig = { ...woe, schedule_weeks: 2, schedule_anchor: '2027-01-11' }
    falsch(scheduleDue(kuenftig, d('2026-08-24T07:30:00')), 'vor dem Anker')
  })
  await pruefe('unvollständige Angaben sind nie fällig', () => {
    falsch(scheduleDue({ schedule_kind: 'woechentlich', schedule_time: '07:30' }, d('2026-08-24T07:30:00')), 'ohne Tage')
    falsch(scheduleDue({ schedule_kind: 'woechentlich', schedule_days: '1' }, d('2026-08-24T07:30:00')), 'ohne Uhrzeit')
    falsch(scheduleDue({ schedule_kind: 'einmalig' }, d('2026-08-24T07:30:00')), 'ohne Termin')
    falsch(scheduleDue({ schedule_kind: 'einmalig', run_at: 'kein datum' }, d('2026-08-24T07:30:00')), 'kaputter Termin')
    falsch(scheduleDue({ schedule_kind: 'cron' }, d('2026-08-24T07:30:00')), 'ohne Ausdruck')
  })
  await pruefe('einmalig: ab dem Termin fällig und wird nachgeholt', () => {
    const ein = { schedule_kind: 'einmalig', run_at: '2026-08-24T09:00' }
    falsch(scheduleDue(ein, d('2026-08-24T08:59:00')), 'davor')
    wahr(scheduleDue(ein, d('2026-08-24T09:00:00')), 'genau')
    wahr(scheduleDue(ein, d('2026-08-25T10:00:00')), 'einen Tag später (Hub war aus)')
  })
  await pruefe('cron-Art nutzt den Cron-Ausdruck', () => {
    const c = { schedule_kind: 'cron', schedule: '0 6 * * 1-5' }
    wahr(scheduleDue(c, d('2026-08-24T06:00:00')), 'Montag 06:00')
    falsch(scheduleDue(c, d('2026-08-23T06:00:00')), 'Sonntag')
  })
  await pruefe('manuell und unbekannte Art sind nie fällig', () => {
    falsch(scheduleDue({ schedule_kind: 'manuell' }, d('2026-08-24T07:30:00')), 'manuell')
    falsch(scheduleDue({ schedule_kind: 'quatsch' }, d('2026-08-24T07:30:00')), 'unbekannt')
    falsch(scheduleDue({}, d('2026-08-24T07:30:00')), 'gar nichts gesetzt')
  })

  // ------------------------------------------------------------------
  gruppe('Zeitpläne: Beschriftung (scheduleText)')

  await pruefe('beschreibt jede Art verständlich', () => {
    enthaelt(scheduleText(zwei), 'alle 2 Wochen', 'n-wöchentlich')
    enthaelt(scheduleText(zwei), 'Mo, Mi, Fr', 'Wochentage')
    enthaelt(scheduleText(zwei), '07:30', 'Uhrzeit')
    enthaelt(scheduleText(woe), 'wöchentlich', 'einfach wöchentlich')
    enthaelt(scheduleText({ schedule_kind: 'einmalig', run_at: '2026-08-24T09:00' }), '2026-08-24', 'Termin')
    gleich(scheduleText({ schedule_kind: 'manuell' }), 'manuell', 'manuell')
    enthaelt(scheduleText({ schedule_kind: 'cron', schedule: '0 6 * * *' }), '0 6 * * *', 'Cron')
  })
  await pruefe('bleibt bei unvollständigen Angaben lesbar', () => {
    const t = scheduleText({ schedule_kind: 'woechentlich' })
    wahr(typeof t === 'string' && t.length > 0, 'liefert Text statt zu werfen')
  })

  // ------------------------------------------------------------------
  gruppe('Formulardaten (parseForm)')

  await pruefe('mehrfach vorkommende Felder landen zusätzlich in <name>_list', () => {
    const b = parseForm('schedule_days=1&schedule_days=3&schedule_days=5')
    gleich(b.schedule_days_list.length, 3, 'Anzahl der Tage')
    gleich(b.schedule_days_list.join(','), '1,3,5', 'Reihenfolge bleibt')
  })
  await pruefe('Einzelwerte bleiben Einzelwerte', () => {
    const b = parseForm('name=hallo&zahl=42')
    gleich(b.name, 'hallo', 'name')
    gleich(b.zahl, '42', 'zahl')
  })
  await pruefe('leerer Body ergibt ein leeres Objekt', () => {
    gleich(Object.keys(parseForm('')).length, 0, 'Feldzahl')
  })
  await pruefe('Prozentkodierung und Pluszeichen werden dekodiert', () => {
    const b = parseForm('text=Hallo+Welt%21&pfad=%2Ftmp%2Fa+b')
    gleich(b.text, 'Hallo Welt!', 'Text')
    gleich(b.pfad, '/tmp/a b', 'Pfad')
  })
  await pruefe('leeres Feld bleibt erhalten (nicht undefined)', () => {
    const b = parseForm('leer=&x=1')
    gleich(b.leer, '', 'leeres Feld')
  })

  // ------------------------------------------------------------------
  gruppe('Textaufbereitung')

  await pruefe('stripAnsi entfernt Steuersequenzen, behält Nutztext', () => {
    gleich(stripAnsi('\x1b[31mrot\x1b[0m'), 'rot', 'Farbcodes')
    gleich(stripAnsi('\x1b[200~eingefügt\x1b[201~'), 'eingefügt', 'Bracketed Paste')
    gleich(stripAnsi('\x1b[2J\x1b[Hgelöscht'), 'gelöscht', 'Bildschirm löschen')
  })
  await pruefe('stripAnsi lässt Umlaute und Zeilenumbrüche unangetastet', () => {
    gleich(stripAnsi('Ärger mit Größe\nzweite Zeile'), 'Ärger mit Größe\nzweite Zeile', 'Umlaute')
  })
  await pruefe('stripAnsi wirft Wagenrücklauf weg, behält Zeilenumbruch', () => {
    gleich(stripAnsi('a\r\nb'), 'a\nb', 'CRLF')
    gleich(stripAnsi('a\rb'), 'ab', 'einzelnes CR')
  })
  await pruefe('escapeHtml entschärft genau die fünf gefährlichen Zeichen', () => {
    gleich(escapeHtml('<b>'), '&lt;b&gt;', 'spitze Klammern')
    gleich(escapeHtml('a & b'), 'a &amp; b', 'Ampersand')
    gleich(escapeHtml(`"x" 'y'`), '&quot;x&quot; &#39;y&#39;', 'Anführungszeichen')
  })
  await pruefe('escapeHtml verdoppelt nichts und verträgt null', () => {
    gleich(escapeHtml('&amp;'), '&amp;amp;', 'einfache Ersetzung, kein Sonderfall')
    gleich(escapeHtml(null), '', 'null')
    gleich(escapeHtml(undefined), '', 'undefined')
    gleich(escapeHtml('harmlos'), 'harmlos', 'unveränderter Text')
  })
  await pruefe('fmtDuration formatiert Minuten und Stunden', () => {
    gleich(fmtDuration(0), '0 min', 'null Sekunden')
    gleich(fmtDuration(90), '1 min', 'anderthalb Minuten')
    gleich(fmtDuration(3661), '1 h 1 min', 'gut eine Stunde')
  })
  await pruefe('fmtDuration weist Unsinn ab, statt NaN anzuzeigen', () => {
    gleich(fmtDuration(-5), '–', 'negativ')
    gleich(fmtDuration(NaN), '–', 'NaN')
    gleich(fmtDuration(undefined), '–', 'undefined')
  })
  await pruefe('kurzid liefert den ersten UUID-Block', () => {
    gleich(kurzid('1d005159-78bd-4cc1-a889-07617871af2e'), '1d005159', 'UUID')
  })

  // ------------------------------------------------------------------
  gruppe('Quota-Gate')

  // QUOTA_PATH wird beim Laden des Moduls gelesen — für jede Fixture einmal frisch
  // importieren (Query-Anhang umgeht den Modul-Cache).
  const quotaMit = async (inhalt, nr) => {
    const pfad = join(sandkasten, `quota${nr}.json`)
    if (inhalt !== null) writeFileSync(pfad, inhalt)
    process.env.CCHUB_QUOTA_JSON = pfad
    return import(`../server/quota.mjs?fixture=${nr}`)
  }

  await pruefe('liest Prozentwerte und Reset-Zeitpunkt', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 91, resets_at: 1800000000 }, seven_day: { used_percentage: 10 },
    }), 1)
    const q = claudeQuota()
    gleich(q.five, 91, '5-Stunden-Wert')
    gleich(q.seven, 10, '7-Tage-Wert')
    wahr(typeof q.resets_at === 'string' && q.resets_at.includes('T'), 'Reset als ISO-Zeit')
  })
  await pruefe('seven_day_fable hat Vorrang vor seven_day', async () => {
    const { claudeQuota } = await quotaMit(JSON.stringify({
      five_hour: { used_percentage: 5 }, seven_day: { used_percentage: 10 }, seven_day_fable: { used_percentage: 42 },
    }), 2)
    gleich(claudeQuota().seven, 42, '7-Tage-Wert')
  })
  await pruefe('fehlende Datei blockiert nichts (alles null)', async () => {
    const { claudeQuota, claudeGateBlocked } = await quotaMit(null, 3)
    const q = claudeQuota()
    gleich(q.five, null, '5h')
    gleich(q.seven, null, '7d')
    falsch(claudeGateBlocked(q).blocked, 'Gate bleibt offen')
  })
  await pruefe('kaputtes JSON blockiert nichts (alles null)', async () => {
    const { claudeQuota } = await quotaMit('{kein json', 4)
    gleich(claudeQuota().five, null, '5h')
  })
  await pruefe('Schwellen: 5h ab 90 %, 7d ab 95 %', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 5)
    falsch(claudeGateBlocked({ five: 89, seven: 0 }).blocked, '89 % läuft')
    wahr(claudeGateBlocked({ five: 90, seven: 0 }).blocked, '90 % blockt')
    falsch(claudeGateBlocked({ five: 0, seven: 94 }).blocked, '7d 94 % läuft')
    wahr(claudeGateBlocked({ five: 0, seven: 95 }).blocked, '7d 95 % blockt')
  })
  await pruefe('Blockade nennt einen Grund', async () => {
    const { claudeGateBlocked } = await quotaMit('{}', 6)
    const g = claudeGateBlocked({ five: 97, seven: 0 })
    wahr(g.blocked && typeof g.reason === 'string' && g.reason.length > 0, 'Grund vorhanden')
  })

  // ------------------------------------------------------------------
  gruppe('Plattform-Zusatz im Prompt (platformSuffix)')

  const { platformSuffix } = await import('../server/runner.mjs')
  const lauf = { id: 'abc-123', workdir_effective: '/pfad/zum/worktree', expected_minutes: 42 }

  await pruefe('setzt alle Platzhalter der Standardvorlage', () => {
    const t = platformSuffix(lauf, 'Lege einen neuen Branch an.', {})
    enthaelt(t, 'abc-123', 'Lauf-ID')
    enthaelt(t, '/pfad/zum/worktree', 'Arbeitsverzeichnis')
    enthaelt(t, '42 min', 'Erwartung')
    enthaelt(t, 'Lege einen neuen Branch an.', 'Branch-Regel')
    falsch(t.includes('{run_id}') || t.includes('{workdir}') || t.includes('{branch_rule}')
      || t.includes('{expected_minutes}'), 'kein Platzhalter bleibt stehen')
  })
  await pruefe('nennt die Rückmeldewege des Agenten', () => {
    const t = platformSuffix(lauf, 'egal', {})
    enthaelt(t, 'cc-report done', 'Abschlussmeldung')
    enthaelt(t, 'cc-report help', 'Hilferuf')
  })
  await pruefe('eigene Vorlage aus den Einstellungen schlägt die Standardvorlage', () => {
    const t = platformSuffix(lauf, 'REGEL', { prompt_suffix: 'Lauf {run_id} in {workdir}, max {expected_minutes} min. {branch_rule}' })
    gleich(t, 'Lauf abc-123 in /pfad/zum/worktree, max 42 min. REGEL', 'eigene Vorlage')
  })
  await pruefe('leere Vorlage fällt auf die Standardvorlage zurück', () => {
    enthaelt(platformSuffix(lauf, 'REGEL', { prompt_suffix: '' }), 'Plattform-Regeln', 'Standardvorlage')
  })
  // ------------------------------------------------------------------
  gruppe('Modell-, Provider- und Effort-Argumente für die Harnesses')

  const { harnessModelArgs } = await import('../server/runner.mjs')
  const cfgAus = (args) => {
    const e = args.find(a => typeof a === 'string' && a.startsWith('OPENCODE_CONFIG_CONTENT='))
    return e ? JSON.parse(e.slice('OPENCODE_CONFIG_CONTENT='.length)) : null
  }
  const paar = (args, flagge) => args[args.indexOf(flagge) + 1]

  await pruefe('claude: Modell und Denk-Aufwand als eigene Flaggen', () => {
    const { args } = harnessModelArgs({ harness: 'claude', model: 'opus', effort: 'max' })
    gleich(paar(args, '--model'), 'opus', 'Modell')
    gleich(paar(args, '--effort'), 'max', 'Denk-Aufwand')
  })

  await pruefe('cursor: nur --model, kein Provider und kein --effort', () => {
    // Die Denk-Stufe steckt bei cursor IN der ID; cursor-agent hat gar kein --effort.
    // Ein durchgereichter Effort darf hier also NICHT als Flagge auftauchen.
    const { args, fehlt } = harnessModelArgs({ harness: 'cursor', model: 'claude-opus-5-xhigh' })
    gleich(paar(args, '--model'), 'claude-opus-5-xhigh', 'Modell wortwörtlich')
    gleich(args.includes('--effort'), false, 'kein --effort')
    gleich(args.includes('--provider'), false, 'kein --provider')
    gleich(fehlt.length, 0, 'kein fehlender Schlüssel — cursor läuft über sein Abo')
    // Auch mit gesetztem Effort am Lauf bleibt die Flagge weg (Altdaten, Harness-Wechsel).
    const b = harnessModelArgs({ harness: 'cursor', model: 'gpt-5.4-mini-low', effort: 'high' })
    gleich(b.args.includes('--effort'), false, 'Effort am Lauf wird nicht durchgereicht')
  })

  await pruefe('hermes: Modell bare, Provider und Effort getrennt', () => {
    const { args } = harnessModelArgs({ harness: 'hermes', provider: 'openrouter', model: 'a/b', effort: 'high' })
    gleich(paar(args, '--model'), 'a/b', 'Modell ohne Präfix')
    gleich(paar(args, '--provider'), 'openrouter', 'Provider')
    gleich(paar(args, '--effort'), 'high', 'Denk-Aufwand')
  })

  await pruefe('opencode: Provider steckt im Präfix — Zen heißt dort "opencode"', () => {
    gleich(paar(harnessModelArgs({ harness: 'opencode', provider: 'opencode-zen', model: 'hy3-free' }).args, '--model'),
      'opencode/hy3-free', 'Zen-Präfix')
    gleich(paar(harnessModelArgs({ harness: 'opencode', provider: 'deepseek', model: 'ds' }).args, '--model'),
      'deepseek/ds', 'DeepSeek-Präfix')
    gleich(paar(harnessModelArgs({ harness: 'opencode', provider: 'openrouter', model: 'a/b' }).args, '--model'),
      'openrouter/a/b', 'OpenRouter-Präfix mit drei Teilen')
  })

  await pruefe('opencode: Effort NICHT als Flagge, sondern in der Konfiguration', () => {
    const { args } = harnessModelArgs({ harness: 'opencode', provider: 'deepseek', model: 'ds', effort: 'high' })
    falsch(args.includes('--effort'), 'kein --effort (die TUI kennt es nicht)')
    const cfg = cfgAus(args)
    // Die Variante wirkt nur, wenn im selben Agenten-Block auch das Modell steht.
    gleich(cfg?.agent?.build?.variant, 'high', 'Variante')
    gleich(cfg?.agent?.build?.model, 'deepseek/ds', 'Modell im selben Block')
  })

  await pruefe('opencode: Anbieter-Pinning und Effort teilen sich EINEN --env-Block', () => {
    const { args } = harnessModelArgs({
      harness: 'opencode', provider: 'openrouter', model: 'a/b', or_provider: 'amazon-bedrock', effort: 'low',
    })
    gleich(args.filter(a => a === '--env').length, args.filter(a => typeof a === 'string' && a.includes('=')).length,
      'jede --env-Flagge hat genau einen Wert')
    const cfg = cfgAus(args)
    gleich(cfg?.provider?.openrouter?.models?.['a/b']?.options?.provider?.order?.[0], 'amazon-bedrock', 'Anbieter')
    gleich(cfg?.agent?.build?.variant, 'low', 'Variante im selben JSON')
  })

  await pruefe('ohne Provider und ohne Effort bleibt alles wie bisher', () => {
    // Regressionsschutz für Bestandsagenten: dort ist 'model' ein freier String.
    const { args } = harnessModelArgs({ harness: 'opencode', model: 'openrouter/a/b' })
    gleich(args.join(' '), '--model openrouter/a/b', 'unverändert durchgereicht')
    gleich(harnessModelArgs({ harness: 'claude' }).args.length, 0, 'ohne Modell gar kein Argument')
  })

  // ------------------------------------------------------------------
  gruppe('Erkennung: Rate-Limit / Provider-Fehler (detect.mjs)')
  const { typVonClaudeFehler, typVonText, terminalText, scanneZeilen, scanneNeueBytes,
    transkriptFehler, bewerteLogTreffer } = await import('../server/detect.mjs')

  await pruefe('Claudes StopFailure-Enum wird vollständig zugeordnet', () => {
    gleich(typVonClaudeFehler('rate_limit'), 'rate_limit', 'rate_limit')
    gleich(typVonClaudeFehler('overloaded'), 'provider_error', 'overloaded')
    gleich(typVonClaudeFehler('server_error'), 'provider_error', 'server_error')
    gleich(typVonClaudeFehler('authentication_failed'), 'auth_error', 'auth')
    gleich(typVonClaudeFehler('oauth_org_not_allowed'), 'auth_error', 'oauth')
    gleich(typVonClaudeFehler('billing_error'), 'billing_error', 'billing')
    gleich(typVonClaudeFehler('account_on_hold'), 'billing_error', 'on hold')
    gleich(typVonClaudeFehler('model_not_found'), 'model_error', 'model')
    gleich(typVonClaudeFehler('max_output_tokens'), null, 'max_output_tokens ist KEIN Provider-Problem')
    gleich(typVonClaudeFehler('unknown'), 'unbekannt', 'unknown')
    gleich(typVonClaudeFehler('irgendwas_neues'), 'unbekannt', 'unbekanntes Enum → unbekannt, kein Absturz')
  })

  await pruefe('Freitext wird in der richtigen Reihenfolge klassifiziert', () => {
    gleich(typVonText('AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream.'), 'rate_limit', 'opencode Rate-Limit (echter Logtext)')
    gleich(typVonText("You've hit your session limit · resets 8:36pm"), 'rate_limit', 'Claude Abo-Limit')
    gleich(typVonText('API Error: 429 Too Many Requests'), 'rate_limit', '429')
    gleich(typVonText('Overloaded'), 'provider_error', 'overloaded')
    gleich(typVonText('API Error: 529 overloaded_error'), 'provider_error', '529')
    gleich(typVonText('Please run /login · API Error: 403'), 'auth_error', '403 + login')
    gleich(typVonText('402 insufficient credits'), 'billing_error', '402 vor Rate-Limit-Prüfung')
    gleich(typVonText('model_not_found: no such model'), 'model_error', 'Modell')
    gleich(typVonText('alles gut'), 'unbekannt', 'kein Treffer')
  })

  await pruefe('terminalText entfernt ANSI, OSC-Titel und macht aus \\r Zeilen', () => {
    const roh = '\x1b]0;✳ Claude Code\x07\x1b[38;5;174m ▐\x1b[39m hallo\r\nzeile2\rzeile3\n'
    gleich(terminalText(roh), ' ▐ hallo\nzeile2\nzeile3\n', 'bereinigt')
  })

  await pruefe('Produktiv-Falschtreffer: "Upgrade to Max for higher rate limits" zündet NICHT', () => {
    const zeilen = ['/upgrade   Upgrade to Max for higher rate limits and more Opus', 'Rate limits', '  rate limit  ']
    gleich(scanneZeilen('claude', zeilen).length, 0, 'Menütext und nackte Überschrift')
  })

  await pruefe('Agent arbeitet am Thema: grep/Quelltext/Tests zünden nicht', () => {
    const zeilen = [
      'grep -rn "rate limit" server/',
      "if (/rate limit|rate.limited/i.test(tail)) { db.prepare('UPDATE runs SET rate_limit_hits=1')",
      "it('meldet 429 als rate_limit', () => {",
      'const retryAfter = res.headers.get("retry-after") // 429',
    ]
    gleich(scanneZeilen('hermes', zeilen).length, 0, 'hermes-Muster auf Quelltext')
    gleich(scanneZeilen('cursor', zeilen).length, 0, 'cursor-Muster auf Quelltext')
    gleich(scanneZeilen('opencode', zeilen).length, 0, 'opencode-Muster auf Quelltext')
  })

  await pruefe('echte Fehlertexte je Harness werden erkannt', () => {
    const c = scanneZeilen('claude', ["You've hit your session limit · resets 8:36pm (Europe/Berlin)", 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'])
    gleich(c.map(t => t.typ).join(','), 'rate_limit,provider_error', 'claude')
    const o = scanneZeilen('opencode', ['AI_APICallError: [Stealth] stealth/ox-alpha is temporarily rate-limited upstream. Please retry shortly.', 'AI_RetryError: Failed after 3 attempts'])
    gleich(o.map(t => t.typ).join(','), 'rate_limit,provider_error', 'opencode')
    const h = scanneZeilen('hermes', [
      '⏳ Retrying in 12.0s (rate limited by upstream provider (429))...',
      '⚠️  API call failed (attempt 2/5): APIConnectionError',
      '   ⏱️  upstream provider overloaded (529)',
    ])
    gleich(h.map(t => t.typ).join(','), 'rate_limit,provider_error,provider_error', 'hermes')
    wahr(h[0].zeile.includes('Retrying'), 'Beleg ist die Zeile')
    // cursor: 'Cannot use this model' ist die WÖRTLICHE Ablehnung der CLI bei einer
    // unbekannten Modell-ID (nachgemessen) — der sicherste Treffer, den cursor liefert.
    const u = scanneZeilen('cursor', [
      'Cannot use this model: gibtsnicht-9000. Available models: auto, gpt-5.2',
      'Error: 429 Too Many Requests',
      'You are not logged in. Please run cursor-agent login',
      'upstream connection error (503)',
    ])
    gleich(u.map(t => t.typ).join(','), 'model_error,rate_limit,auth_error,provider_error', 'cursor')
  })

  await pruefe('Offset-Scan: unvollständige Schlusszeile wird zurückgestellt, nicht verbraucht', () => {
    const teil1 = 'foo\n⚠️  API call failed (attempt 1/5): RateLimit'
    const r1 = scanneNeueBytes('hermes', teil1, 100)
    gleich(r1.treffer.length, 0, 'halbe Zeile zählt nicht')
    gleich(r1.neuerOffset, 100 + Buffer.byteLength('foo\n'), 'Offset zeigt auf den Anfang der halben Zeile')
    const teil2 = '⚠️  API call failed (attempt 1/5): RateLimitError (HTTP 429)\n'
    const r2 = scanneNeueBytes('hermes', teil2, r1.neuerOffset)
    gleich(r2.treffer.length, 1, 'vollständig → Treffer')
    gleich(r2.treffer[0].typ, 'rate_limit', 'Typ')
    gleich(r2.neuerOffset, r1.neuerOffset + Buffer.byteLength(teil2), 'Offset am Ende')
  })

  await pruefe('Offset-Scan: ohne Zeilenumbruch bewegt sich nichts', () => {
    const r = scanneNeueBytes('claude', 'nur ein Stück', 7)
    gleich(r.neuerOffset, 7, 'Offset bleibt')
    gleich(r.treffer.length, 0, 'kein Treffer')
  })

  await pruefe('Claude-Transkript: isApiErrorMessage-Zeilen mit Enum und Zeitstempel', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', message: { content: 'hi' } }),
      JSON.stringify({ type: 'assistant', error: 'rate_limit', timestamp: '2026-08-23T17:36:32.446Z', isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: "You've hit your session limit · resets 8:36pm" }] } }),
      JSON.stringify({ type: 'assistant', error: 'max_output_tokens', isApiErrorMessage: true, message: { content: 'x' } }),
      '{"kaputt": tru',
    ].join('\n')
    const f = transkriptFehler(jsonl)
    gleich(f.length, 1, 'genau ein relevanter Fehler (max_output_tokens und Müll ignoriert)')
    gleich(f[0].typ, 'rate_limit', 'Typ')
    gleich(f[0].ts, '2026-08-23T17:36:32.446Z', 'Zeitstempel')
    enthaelt(f[0].text, 'session limit', 'Text')
  })

  await pruefe('Bewertung: ein einzelner Treffer mit Weiterarbeit bleibt gelb', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 + 60_000, jetztMs: t0 + 6 * 60_000 }), 'gelb', 'Aktivität nach dem Treffer')
  })
  await pruefe('Bewertung: Stille nach dem Treffer wird rot (das Limit steht am Ende)', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 5 * 60_000 }), 'rot', '5 min still')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: null, jetztMs: t0 + 5 * 60_000 }), 'rot', 'nie Aktivität gemessen')
    gleich(bewerteLogTreffer({ anzahl: 1, erstGesehenMs: t0, zuletztGesehenMs: t0, letzteAktivitaetMs: t0 - 1000, jetztMs: t0 + 2 * 60_000 }), 'gelb', 'erst 2 min still')
  })
  await pruefe('Bewertung: Wiederholung binnen 10 min wird rot (Retry-Schleife)', () => {
    const t0 = Date.parse('2026-08-23T10:00:00Z')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 3 * 60_000, letzteAktivitaetMs: t0 + 4 * 60_000, jetztMs: t0 + 4 * 60_000 }), 'rot', '2× in 3 min')
    gleich(bewerteLogTreffer({ anzahl: 2, erstGesehenMs: t0, zuletztGesehenMs: t0 + 40 * 60_000, letzteAktivitaetMs: t0 + 41 * 60_000, jetztMs: t0 + 41 * 60_000 }), 'gelb', '2× mit 40 min Abstand ist keine Schleife')
  })

  // ------------------------------------------------------------------
  gruppe('Zusatz-Skills (zusaetze.mjs)')
  const zdir = join(sandkasten, 'zusaetze')
  process.env.CCHUB_ZUSAETZE_DIR = zdir
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(zdir, 'unlazy'), { recursive: true })
  writeFileSync(join(zdir, 'unlazy', 'SKILL.md'),
    '---\nname: unlazy\ndescription: Enforces completion discipline for lazy models.\n---\n\n# Unlazy\n')
  mkdirSync(join(zdir, 'ohne-skillmd'), { recursive: true })
  const { zusatzSkills, skillsAusFormular, skillPromptZusatz, skillListe } = await import('../server/zusaetze.mjs')

  await pruefe('Ordner mit SKILL.md werden gefunden, Frontmatter gelesen, Rest ignoriert', () => {
    const l = zusatzSkills()
    gleich(l.length, 1, 'nur der echte Skill')
    gleich(l[0].name, 'unlazy', 'Ordnername')
    gleich(l[0].titel, 'unlazy', 'Frontmatter-Name')
    enthaelt(l[0].beschreibung, 'completion discipline', 'Beschreibung')
    gleich(l[0].pfad, join(zdir, 'unlazy', 'SKILL.md'), 'voller Pfad')
  })
  await pruefe('Formular-Auswahl: nur bekannte Namen überleben, leer wird null', () => {
    gleich(skillsAusFormular({ skills_list: ['unlazy', 'boese-eingabe'] }), '["unlazy"]', 'gefiltert')
    gleich(skillsAusFormular({}), null, 'keine Auswahl → null')
    gleich(skillsAusFormular({ skills: 'unlazy' }), '["unlazy"]', 'Einzelwert ohne _list')
  })
  await pruefe('Prompt-Zusatz nennt den vollen SKILL.md-Pfad und das Verzeichnis', () => {
    const z = skillPromptZusatz('["unlazy"]')
    enthaelt(z, join(zdir, 'unlazy', 'SKILL.md'), 'voller Pfad')
    enthaelt(z, 'GESAMTEN Auftrags', 'Anweisung anzuwenden')
    gleich(skillPromptZusatz(null), '', 'ohne Auswahl kein Zusatz')
  })
  await pruefe('gewählter, aber gelöschter Skill wird ehrlich benannt statt tot verlinkt', () => {
    const z = skillPromptZusatz('["weg-damit"]')
    enthaelt(z, "'weg-damit'", 'Name')
    enthaelt(z, 'nicht mehr', 'Hinweis')
  })
  await pruefe('kaputtes JSON in der DB-Spalte stürzt nicht ab', () => {
    gleich(skillListe('{kaputt').length, 0, 'leer')
  })
  await pruefe('Regler: gewählte Tiefe wandert als "unlazy:N" in die DB und als "tree N" in den Prompt', () => {
    gleich(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '4' }), '["unlazy:4"]', 'kodiert')
    const z = skillPromptZusatz('["unlazy:4"]')
    enthaelt(z, '"tree 4"', 'Trigger aus der SKILL.md')
    enthaelt(z, 'Tiefe 4', 'Klartext')
    enthaelt(z, 'SKILL.md', 'Verweis bleibt')
  })
  await pruefe('Regler: unbekannte oder manipulierte Werte fallen auf "Skill entscheidet" zurück', () => {
    gleich(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '9' }), '["unlazy"]', '9 gibt es nicht')
    gleich(skillsAusFormular({ skills: 'unlazy', skill_regler_unlazy: '4; rm -rf' }), '["unlazy"]', 'Müll')
    gleich(skillsAusFormular({ skills: 'unlazy' }), '["unlazy"]', 'ohne Regler')
    falsch(skillPromptZusatz('["unlazy"]').includes('tree'), 'ohne Wert keine tree-Zeile')
  })

} finally {
  rmSync(sandkasten, { recursive: true, force: true })
}

process.exit(bericht('Unit-Tests', start) || (zaehler.fehler.length ? 1 : 0))
