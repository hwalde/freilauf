// Freilauf — model provider plugin registry.
//
// A "provider" here is an inference provider that serves models to
// provider-based coding agents (opencode, hermes). Each built-in provider is
// one file in this directory exporting a plain descriptor object — see
// docs/plugins.md for the contract.
//
// The registry itself lives in server/plugins/registry.mjs, so an external
// package can join it at startup. This file is the unchanged front door: it
// re-exports the very same `PROVIDER_PLUGINS` object and the same functions.
export {
  PROVIDER_PLUGINS,
  providerIds,
  getProvider,
  providerLabel,
  providerHasKey,
} from '../plugins/registry.mjs'
