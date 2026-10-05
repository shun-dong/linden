# Changelog

## 1.0.0 — 2026-10-05

This release includes the improvements made after the initial `paper version`
snapshot, commit `83955fe2db0d80b2d0d9f656bb0f2b3b4ea710b5`
(2026-09-30), through Linden 1.0.0. This hash identifies the local research
history; the public product history starts at `d422a50`.

### Workspaces and initial permissions

- Standardized product terminology: a workspace owns the authority ledger and
  participant tree; each Agent has a Pi session. Historical `session:<UUID>`
  workspace IDs and storage locations remain stable.
- Added typed startup permissions using `file:...`, `&file:...`,
  `net:tcp/...`, and `&net:tcp/...`, with `--root`, `--no-default-permissions`,
  and `--workspace` controls. Explicit permissions replace defaults per resource
  kind. New workspaces default to complete root File and public TCP Net authority.
- Separated root location from authority. File grants can cover multiple roots
  and paths outside the workspace root, while private runtime state stays excluded.
- Added participant roots, inherited from the parent or overridden with
  `spawn --root` / `rootDir`. Human children use the current CLI directory;
  Agent Bash starts at its own root, and Term retains its shell directory and
  environment. An unreadable working directory appears as an empty sandbox skeleton.
- Replaced root-overlap exclusion with File write-set exclusion, including exact
  atoms and region exclusions. Workspaces with overlapping roots or read ranges
  can run together when write authority is disjoint. The same workspace remains
  exclusive. Updated lease records and acquire-before-restore behavior; a live
  process no longer loses its lease solely because its heartbeat is old.
- Documented global `linden` and `linden-check` installation and reopening a
  workspace from any directory. Fixed CLI entry-point detection through global
  symlinks.
- Replaced the old split startup flags and attached Human command surface with
  typed permissions and the outer CLI. `--workspace` now selects a workspace ID;
  `--root` selects its location.

### Permission requests, handoffs, and displays

- Reused `get` for permission requests to the direct parent. Requests do not grant
  authority; approval uses `give` or the parent's own `permission all-of-mine`
  policy. The default is `manual`. Automatic approval uses currently grantable
  authority without reclaiming siblings or requesting permission upward.
- Preserved direct-child `get` as complete-authority reclamation. An Agent's
  already-started tool finishes before reclamation; later tools wait for commit,
  and the model loop can continue afterward. Open Term epochs still require
  explicit completion or stopping before conflicting handoffs.
- Added sequential batches to `give/get`: tools accept either `resource` or a
  non-empty `resources` array, and CLI commands accept multiple resources. The
  first failure or unavailable item stops the batch. Earlier successes remain;
  receipts identify completed, failed, and unattempted items.
- Reconciled external File changes during complete ownership handoff. Disk bytes,
  modes, and deletions become a new child of the current File history node;
  history is preserved and verified divergence is cleared. The version update
  and each individual ownership transfer commit together, with an explanatory
  receipt and runtime notice. Matching disk state clears verified divergence
  without creating a duplicate version.
- Directory handoffs reconcile tracked Files actually being transferred.
  Use-projection grants and pending requests do not reconcile Files; open write
  epochs, unstable captures, and unsupported File states still reject handoffs.
- Added `:save` for external changes within Human-owned write authority, including
  additions, content, modes, and deletions. It uses the existing version/journal
  path, excludes delegated and already-divergent Files, and retains discovery
  exclusions for untracked dependency and generated directories.
- Unified participant tree formatting across CLI, tools, and runtime context:
  `name(id) | relationship | lifecycle | permissions`. Removed redundant
  `kind=`, `lifecycle=`, and `held:` labels; every participant shows its permissions.
- Added authority summaries with ranges and exceptions for held permissions and
  the managed subtree, without treating subtree authority as personally held rights.

### TCP Net capabilities and Term publication

- Added `Net` and `&Net` to compiler checking, runtime judgments, storage, tools,
  and sandbox enforcement. New grants use exact TCP IP/port or DNS/port identities,
  including IPv6, or the predefined public endpoint set. Historical Web records
  remain available for compatibility and audit.
- Complete Net authority supports connection, refinement, direct-edge transfer,
  and publication. `&Net` allows bidirectional TCP connection only; it cannot be
  forwarded, inherited, refined, or used to manage publication. Children receive
  no Net authority implicitly.
- Distinguished DNS and IP identities. DNS targets are resolved, checked, and
  audited on each connection. Public and DNS grants reject private/reserved
  targets; explicit private IP grants remain supported.
- Added mediated network transport through workspace Unix-socket brokers and
  NetGuard, including private network namespaces for sandboxed workloads.
- Added `publish` / `unpublish` for a controlled descendant Term's internal TCP
  service using complete exact Net authority. Publication uses a broker instead
  of an implicit host bind. Published Net must be unpublished before transfer.
- Extended the native Term supervisor with publication control and acknowledgments.
  Unpublish closes bridges and their connections while leaving the service alive;
  authority changes close connections belonging to the previous holder.

### Archive, restore, fork, and runtime delivery

- Replaced destructive participant archive with retained stopped subtrees,
  preserving history, checkpoints, messages, and original permission templates
  while reclaiming live rights and roles.
- Added atomic `unarchive`: all original permissions must be recoverable, and
  restored participants stay stopped. Old unread mail remains explicitly
  receivable without automatically replaying tasks.
- Unchanged File restoration adds no message. Changed Files are preserved as new
  versions with notices. Restored Net always explains that connections,
  publication bridges, and remote state were not resumed.
- Workspace exit quiesces participants and archives authority before releasing
  the write lease. Reopening restores authority atomically and retains stopped
  participants without restarting their previous processes or model turns.
- Added history-only `fork` from a live or retained direct-child Agent. The new
  Agent receives fresh session/entry IDs and a mandatory fork notice, without
  resource rights, children, policies, old typed checkpoints, processes, or
  pending deliveries.
- Added durable authority-change and restoration notices with retry and event-ID
  deduplication. Runtime notices persist without starting a model turn or
  steering tools; committed changes remain committed if adapter delivery fails.
- Made steering interrupt pending waits, alongside ordinary follow-ups and runtime
  notices, so new context can be processed promptly.
- Hardened Agent creation/restoration: subscriptions are prepared before runtime
  publication, failed preparation is cleaned up, and failed restoration can be
  retried without leaving a stale session binding.
- Clarified outer Human CLI and attached participant controls, and updated model
  guidance for permissions, lifecycle, network operations, and restoration.
  Added `:attach <term>` for an interactive Term console.

### Agent history branches

- Changed the current-history model to `current branch -> history node`, with
  `main` as the initial branch. Named heads share the existing history tree.
- Added `:branch <agent> <name> [state-id]` to create and select a branch, preserving
  the full current context when the state is omitted, and `:switch <agent> <name>`
  to select an existing branch. Model tools expose `branch` and `switch`.
- Updated `rewind` to move the selected branch head while retaining other branches
  and old history nodes. Navigation keeps the direct-parent control rule.
- Navigation waits for started tools, stops the current model turn, and seals its
  progress. It starts no new model turn and does not roll back files, authority,
  messages, or external effects. A runtime notice records this boundary.
- Routed attached Pi `/tree` through the same navigation mechanism. Raw user and
  custom-message selections receive exact typed anchors, preserving the selected
  message instead of returning its text to the editor.
- Preserved the user's optional branch-summary choice. Summaries, restoration
  notices, and subsequent checkpoints advance only the selected branch.
- Added branch names, target nodes, and current-branch markers to `/tree` and
  Agent `log`. Tree annotations affect display only and preserve user labels.
- Added navigation conflict checks, context rollback on failure, and cold-restore
  alignment between Pi context and the recorded branch head. Workspace and
  subtree archive/restore retain branch references.

### Pi reads, diagnostics, and runtime requirements

- Reused Pi's native `read` definition and renderers for text and images,
  preserving image detection/resizing, truncation, cancellation, and missing-file
  behavior. Linden supplies one authorized published byte view for both MIME
  detection and payload, preventing reads of uncommitted epoch contents.
- Added an opt-in `npm run test:live:luna` smoke test using configured
  `openai-codex/gpt-6-luna`, isolated Pi settings, and temporary reports. Credential
  copies are removed afterward; normal tests do not call a model provider.
- Recorded real terminal tests and native Pi image comparisons, plus a separate
  transport investigation reproducing `fetch failed` before response headers and
  `terminated` after stream interruption in both native Pi and Linden. This is
  diagnostic evidence, not a claimed provider transport fix.
- Added shared executable and runtime capability checks without relying on
  `which`. Diagnostics distinguish absent/non-executable tools, broken links,
  missing loaders, command failures, and timeouts.
- Distinguished Bubblewrap installation from successful namespace isolation using
  an actual isolation probe. Tests report capability-based skips; pure logic
  tests supply participant identities explicitly rather than relying on sandbox
  OS-user lookup.

### Storage compatibility and project maintenance

- Added explicit initial File/Net authority and workspace manifest permissions;
  legacy implicit permissions are materialized during migration after backup.
  Read-only initial permissions do not become executable complete authority.
- Added ledger v8 branch references inside typed Agent state. Current-state
  indexes are derived from the selected head. v6/v7 histories migrate to `main`
  while preserving all nodes and an original ledger backup.
- Older Linden versions cannot open v8 ledgers. v5 requires explicit migration
  first; v1–v4 remain unsupported. History deleted by earlier destructive archives
  cannot be reconstructed.
- Extracted shared Pi hooks into `src/pi/hooks.ts` and legacy parser/network
  adapters into compatibility modules; separated current Net transport into
  `network-bridge.ts`. Documented `src/runtime/` as the canonical implementation
  and retained compatibility import paths and codec aliases without duplicating
  implementations. Enabled unused-local and unused-parameter type checks.
- Reorganized 29 historical paper-editing and backup files in the local research
  checkout, preserving bytes and permissions with a SHA-256 relocation manifest.
  Removed generated caches and stray metadata. Papers, research archives,
  experiment data, and frozen submission artifacts are excluded from this product
  release.
- Added a local-only `dev` workflow and a separately curated `release` worktree
  based on the initial public product snapshot. Default pushes select only the
  release branch; local preparation does not publish to GitHub.
- Updated README for the workspace/Net model; internal product, runtime,
  language, and type theory documents remain on `dev`. Set package and lockfile
  release versions to `1.0.0`.

### Release validation

- Built Linden 1.0.0, including the native Term supervisor.
- Independently installed and validated the standalone release checkout: strict
  type checking and all 297 automated tests passed, with no failures or skips.
- Passed 146 related regression tests covering history branches, authority,
  permissions, transfers, compatibility, Pi hooks, topology races, and persistence.
- Verified the global `linden` CLI and attached Pi UI through real keyboard input
  with local `openai-codex/gpt-6-luna`: independent branch contexts,
  `branch/switch/rewind`, tree markers, optional summaries, exact message
  selection, and persistence after workspace reopening.
- Ran the standalone release terminal UI from a separate working directory:
  sandboxed Bash File writes/reads, Term execution/logs, an attached
  `gpt-6-luna` reply, branch creation/switching, and archived workspace reopening
  all succeeded. Temporary credential copies were removed.
- Published a [1.0 validation summary](doc/validation/1.0.0.md). Raw UI records
  and transport investigation traces remain in the local research checkout.

See [README](README.md) for current usage and
[release workflow](doc/releasing.md) for local preparation and publishing.

## Initial baseline — 2026-09-30

- `83955fe2db0d80b2d0d9f656bb0f2b3b4ea710b5` — `paper version`.
- This snapshot is the starting point for the release history above; features
  already present at that commit are not listed as new 1.0 improvements.
