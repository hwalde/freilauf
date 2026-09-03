// Freilauf — coding agent (harness) plugin registry.
//
// A "coding agent" is a CLI harness the hub can drive inside a tmux session
// (Claude Code, opencode, hermes, cursor-agent). Each built-in one is a file in
// this directory exporting a plain descriptor object — see docs/plugins.md for
// the full contract and how to add a new one.
//
// Since coding agents became loadable plugins, the registry itself lives in
// server/plugins/registry.mjs, where an external package can join it at
// startup. This file is the unchanged front door: it re-exports the very same
// `HARNESS_PLUGINS` object and the same functions, so nothing that imports it
// had to change and a plugin registered later is already in the object every
// importer holds.
export {
  HARNESS_PLUGINS,
  harnessIds,
  getHarness,
  harnessLabel,
  goalSpec,
  harnessesWithGoal,
  skillSpec,
  harnessesWithSkills,
  detectInstalled,
} from '../plugins/registry.mjs'
