// Freilauf — code review platform plugin registry.
//
// A "review platform" is where a run's branch becomes a pull/merge request
// instead of being merged by the hub itself: GitHub, GitLab, Bitbucket Cloud
// and Bitbucket Data Center are built in, anything else is a package under
// FREILAUF_PLUGIN_DIR. Each built-in is one file in this directory exporting a
// plain descriptor object — see docs/plugins.md for the contract.
//
// The registry itself lives in server/plugins/registry.mjs, so an external
// package can join it at startup. This file is the front door, the same shape
// `server/notifiers/index.mjs` has: it re-exports the very same
// `REVIEW_PLUGINS` object and the same functions.
export {
  REVIEW_PLUGINS,
  reviewPlatformIds,
  getReviewPlatform,
  reviewPlatformLabel,
} from '../plugins/registry.mjs'
