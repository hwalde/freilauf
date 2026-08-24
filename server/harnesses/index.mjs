// cc-hub — coding agent (harness) plugin registry.
//
// A "coding agent" is a CLI harness the hub can drive inside a tmux session
// (Claude Code, opencode, hermes, cursor-agent). Each one is a file in this
// directory exporting a plain descriptor object — see docs/plugins.md for the
// full contract and how to add a new one.
//
// Plugins are pure data + functions with injected helpers. They must NOT import
// db.mjs or i18n.mjs: this registry is imported by db.mjs itself (to keep the
// CHECK constraint on agents.harness in sync), so that would be a cycle.
import { execFile } from 'node:child_process'
import claude from './claude.mjs'
import opencode from './opencode.mjs'
import hermes from './hermes.mjs'
import cursor from './cursor.mjs'

export const HARNESS_PLUGINS = { claude, opencode, hermes, cursor }

export function harnessIds() { return Object.keys(HARNESS_PLUGINS) }
export function getHarness(id) { return HARNESS_PLUGINS[id] ?? null }
export function harnessLabel(id) { return HARNESS_PLUGINS[id]?.label ?? id }

/**
 * Which of the registered plugins are actually installed on this machine?
 * Used by the "add coding agent" dialog to suggest what can be added.
 * `command -v` is the portable way to ask the shell; a missing binary is a
 * normal answer here, not an error.
 */
export async function detectInstalled() {
  const out = []
  for (const plugin of Object.values(HARNESS_PLUGINS)) {
    const installed = await new Promise((resolve) => {
      execFile('sh', ['-c', `command -v ${plugin.bin}`], { timeout: 5000 },
        (err, stdout) => resolve(!err && !!String(stdout).trim()))
    })
    out.push({ id: plugin.id, label: plugin.label, bin: plugin.bin, installed, installHint: plugin.installHint })
  }
  return out
}
