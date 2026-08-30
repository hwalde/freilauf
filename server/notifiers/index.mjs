// cc-hub — notification channel plugin registry.
//
// A "notifier" is a channel the hub can say something on: Telegram is the only
// built-in one, a webhook, a Slack app or an SMTP sender is a package under
// CCHUB_PLUGIN_DIR. Each built-in notifier is one file in this directory
// exporting a plain descriptor object — see docs/plugins.md for the contract.
//
// The registry itself lives in server/plugins/registry.mjs, so an external
// package can join it at startup. This file is the front door, the same shape
// `server/harnesses/index.mjs` and `server/providers/index.mjs` have: it
// re-exports the very same `NOTIFIER_PLUGINS` object and the same functions.
//
// Nothing in the hub imports a notifier directly. The one caller is the facade
// `server/notify.mjs`, and that is the whole point: notifications are optional,
// and an installation with none configured must be able to run without a single
// module noticing.
export {
  NOTIFIER_PLUGINS,
  notifierIds,
  getNotifier,
  notifierLabel,
  notifiersWithSetup,
} from '../plugins/registry.mjs'
