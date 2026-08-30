---
name: Bug report
about: Something in Freilauf does not behave as described
labels: bug
---

**What happened, and what you expected instead**

**How to reproduce** — the smallest path you know of.

**Which coding agent** (claude / opencode / hermes / cursor) and which model, if
it is specific to one.

**Output that helps** — please redact ports, addresses, hostnames and keys:

```
freilauf status
freilauf logs        # the lines around the problem
node --version
git -C ~/agents/deploy/freilauf rev-parse --short HEAD   # or the sha in the sidebar
```

**Anything else** — an incident on the run's detail page, the run's report, a
screenshot for UI problems.
