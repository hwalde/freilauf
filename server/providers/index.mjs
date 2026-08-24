// cc-hub — model provider plugin registry.
//
// A "provider" here is an inference provider that serves models to provider-based
// coding agents (opencode, hermes). Each provider is one file in this directory
// exporting a plain descriptor object — see docs/plugins.md for the contract.
//
// Plugins are pure data + fetch functions with injected helpers. They must NOT
// import db.mjs or i18n.mjs (the registry is imported by db.mjs — that would be
// a cycle). Labels/hints shown in the UI are assembled by the callers.
import openrouter from './openrouter.mjs'
import deepseek from './deepseek.mjs'
import opencodeZen from './opencode-zen.mjs'

export const PROVIDER_PLUGINS = {
  openrouter,
  deepseek,
  'opencode-zen': opencodeZen,
}

export function providerIds() { return Object.keys(PROVIDER_PLUGINS) }
export function getProvider(id) { return PROVIDER_PLUGINS[id] ?? null }
export function providerLabel(id) { return PROVIDER_PLUGINS[id]?.label ?? id }

/** Does the environment hold a credential for this provider? */
export function providerHasKey(id, env = process.env) {
  return (getProvider(id)?.envKeys ?? []).some(name => !!env[name])
}
