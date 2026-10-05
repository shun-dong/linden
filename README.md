# Linden

Linden **1.0** is a participant authority runtime for Pi `0.84.2`. A **workspace** contains one authority ledger and a Human/Agent/Term tree; each Agent has its own Pi **session**. Historical `session:<UUID>` workspace IDs and storage paths remain stable. Release notes are in [CHANGELOG.md](CHANGELOG.md).

## Repository layout

- `src/compiler/`: language front end and pure authority judgments.
- `src/runtime/`: the shared authority manager, persistence, sandboxes, Term and Net adapters.
- `src/pi/`: Pi tools, shared extension hooks, participant coordination, and the standalone host.
- `src/authority/`: deprecated import paths only; new code imports `src/runtime/` directly.
- `native/term-supervisor/`: Rust process/PTY supervision, not a second authority ledger.
- `test/`, `scripts/`, `examples/`: regression tests, build/validation helpers, and language examples.
- `doc/`: English release workflow and public validation summaries.
  Product usage is documented in this README; internal design and theory notes stay on `dev`.

This product checkout excludes papers, experiments, reference PDFs, and raw session records. The local development/release workflow is described in [doc/releasing.md](doc/releasing.md).

Shared Pi hooks live in `src/pi/hooks.ts`; the former attached spawn parser lives in `src/pi/compat.ts`. Historical Web and evaluator loopback adapters live in `src/runtime/compat/network.ts`, while current Net transport uses `network-bridge.ts`. Deprecated import paths and ledger codec names remain aliases, not duplicate implementations. Type checking rejects unused locals and parameters. Generated caches and research materials are excluded from the product checkout.

## Setup

Node `>=22.19` and Pi `0.84.2` are required. Building the native Term supervisor also requires Rust/Cargo. Physical Bash/Term enforcement requires Linux/WSL, `bubblewrap`, `socat`, and `script`.

```bash
npm ci
cargo fetch --locked --manifest-path native/term-supervisor/Cargo.toml
npm run check
npm test
npm run build
```

The native build runs Cargo offline with locked dependencies. Run `cargo fetch`
once on a new machine, and again when the Cargo lockfile changes.

The version-specific postinstall patch makes Pi `/exit` detach without stopping the Agent.

To install the current checkout globally in WSL after building:

```bash
npm link
cd /path/to/project
linden
```

This starts a workspace rooted at the current directory. The global commands `linden` and `linden-check` link to the checkout where you run `npm link`; run `npm run build` after source changes to update them. Use `linden --workspace <id-or-unique-suffix>` to reopen an existing workspace from any directory.

For an opt-in live test with your configured `openai-codex/gpt-6-luna` credentials, build first and run `npm run test:live:luna`. The test uses real Pi sessions and Linux sandboxes, checks permission requests, image payloads, Bash/Term, restoration and fork, and writes a JSON report in a temporary directory. It uses an isolated Pi configuration at thinking level `low`, preserves your defaults, and removes its copied credentials after completion. Normal `npm test` does not call a model provider.

## Start a workspace

```bash
# Defaults: complete File authority at root/cwd and complete public TCP Net authority
node dist/cli.js [root]

# Typed positional permissions; quote & in your shell
node dist/cli.js --root ./project file:./src/ '&file:../references/' '&net:tcp/dns/example.com:443'

# Disable all defaults, or reopen a stable workspace
node dist/cli.js --no-default-permissions '&file:./'
node dist/cli.js --workspace <id-or-unique-suffix>
```

Explicit permissions replace defaults **per resource kind**. The root is a position, not an authorization boundary. File grants can cover external roots. Concurrent workspaces are allowed when their complete File write sets do not overlap, even if their roots or read sets overlap. The same workspace cannot be activated twice.

File atoms use `file:<canonical-path>`; regions end in `/`. `Net` uses exact TCP IP/DNS endpoints, including IPv6, or the built-in public endpoint set:

```text
net:tcp/1.2.3.4:40001
net:tcp/dns/example.com:443
net:tcp/[2001:db8::1]:80
net:tcp/public
```

Complete `Net` permits connection, publication, refinement, and direct-edge transfer. `&Net` permits connection only; it cannot be forwarded, inherited, refined, or used for publication. TCP remains bidirectional. DNS and IP identities are distinct. Every DNS connection is resolved and audited; DNS/private-target rejection prevents public grants from reaching private networks. Explicit private IP grants are supported.

## Control plane

```text
:participants                    tree with each participant's held permissions
:authority [participant]         held permissions, managed subtree union, and policy
:permission [manual|all-of-mine]  your direct-child permission request policy
:spawn review --root ./src --give &file:./src/
:spawn shell --kind term --no-cwd-read
:give review file:./src/
:get review file:./src/
:attach <agent|term>
:publish <term> <net:endpoint> <internal-port>
:unpublish <net:endpoint>
:save
:archive <stopped-direct-child>
:unarchive <retained-direct-child>
:fork <direct-child-agent> [name]
:archive                         stop and archive this workspace, then exit
:resume                          list or switch workspaces while stopped
:exit
```

Ordinary CLI text runs one sandboxed Bash command as Human. `cd` changes CLI cwd. Child roots inherit their parent's root (Human uses current CLI cwd); an explicit root overrides it. Agent Bash starts at its own root; Term keeps shell cwd and environment. An unreadable cwd becomes an empty sandbox skeleton and does not expose host contents.

`get` from a direct child reclaims complete authority. Agent `get` from its direct parent **requests** permission; manual approval uses `give`, or the parent enables `permission all-of-mine`. Automatic approval uses only currently grantable authority and never reclaims siblings or requests upward. There is no separate request tool.

`give` and `get` tools accept either a single `resource` or a non-empty `resources` array, never both. CLI commands accept multiple resource arguments, for example `:get <direct-child> file:./first.txt file:./second.txt`. Items run in input order. The first failure or unavailable permission stops the batch; earlier results remain, and the receipt lists completed items, the failed item and reason, and items not attempted. Pending requests to a parent still grant no authority. Each item retains the existing direct-edge, permission, Term epoch, and Net publication checks.

Agent attach exposes `:authority`, `:participants`, and `:permission` for the attached Agent. `/exit` detaches. Term attach exposes execution, input, listen, authority, and detach; detaching leaves the Term running. General Human controls stay in the outer CLI.

## History and messages

Agent history has a selected branch and named branch heads. New checkpoints advance only the selected branch. Use `:branch <agent> <name> [agent-state-id]` to create a branch and switch to it (omit the state to preserve the full current context), `:switch <agent> <name>` to select an existing branch, and `:rewind <agent> <agent-state-id>` to move the selected branch. Old nodes and other branches remain available. The model tools are `branch({participant, name, state?})`, `switch({participant, name})`, and `rewind({participant, state})`; they retain the direct-parent navigation rule.

Agent `log` lists every branch and its target state/Pi entry, marks the selected branch, and labels branch tips in the history. Attached Pi `/tree` shows the same branch references and routes navigation through Linden rewind. Raw message selections receive an exact typed anchor, including the selected user/custom message rather than putting its text back in the editor. The user's summary choice is preserved; summaries and the runtime notice become part of the selected branch, whose head advances to the new notice checkpoint. Navigation itself starts no model turn and does not roll back resource authority or external effects.

Ledger v8 stores Agent branch references inside the typed Agent state; the current-state index is derived from the selected head. Existing v6/v7 histories reopen on `main` without losing nodes, and migration retains the original ledger backup. Workspace and subtree archive/restore retain branches. Older Linden versions cannot open v8 ledgers.

Exit quiesces participants and archives workspace authority before releasing the write lease. Reopen atomically restores rights and leaves participants stopped. Participant archive retains its subtree and history while reclaiming rights; unarchive succeeds only if **all** original permissions can be restored. Unchanged File restoration adds no notice. Changed Files become new versions and generate notices; restored Net always explains that connections and publication bridges were not resumed. Old unread messages remain explicitly receivable but do not automatically replay tasks.

Fork copies one Agent's current branch into a new Agent with fresh session/entry IDs, no resource rights, no children, no old typed checkpoints, no processes or pending delivery. A mandatory fork notice explains the new context.

Runtime messages, follow-ups, and steering all interrupt waits. Runtime messages persist without starting a turn or blocking subsequent tools; follow-ups and steering can wake stopped live Agents; steering also blocks tools that have not begun. Runtime notice delivery is durable, retried, and deduplicated by event ID.

## Enforcement and persistence

When complete File ownership moves through `give` or `get`, the runtime compares disk state with the current ledger version. External changes become a new child of that current version, preserving the existing history, disk bytes, file mode, and deletions. The version update and the single ownership transfer commit together, clear divergence, and explain the imported version in the receipt and runtime notice. Directory transfers check the tracked Files actually moving with the directory. If disk already matches the current version, a verified divergence marker is cleared without adding a duplicate version. Use-projection grants and pending permission requests do not perform this reconciliation. Open Term write epochs, unstable captures, and unsupported File states still refuse the transfer.

The pure compiler judgments govern resource transfer and access. Native File mutations use content-addressed versions and recovery journals; `:save` imports external Human-owned changes through the same multi-resource commit and excludes delegated rights. Native Pi `read` retains images, truncation, cancellation and missing-file errors; the underlying typed read/stat still represent `Absent`. Reads during a writing epoch use the same committed byte snapshot for text and images.

Already divergent Files are excluded from the effective writable set used by `:save`; that command alone does not clear their divergence. Typed read/stat/write/edit/checkout remain rejected until reconciliation succeeds.

Publication routes a Term internal port through a private Unix socket broker, without binding an arbitrary host port. Published Net must be unpublished before complete transfer. Unpublish closes bridges and connections while leaving the service alive. Net holder changes close the former holder's established connections.

State stays under `~/.linden/sessions/<workspace-uuid>/`: `session.json`, schema-v8 `ledger.json`, `process-state.json`, `blobs/`, `journal/`, `mail-payloads/`, `pi-sessions/`, and `network-audit.jsonl`. v6 opening keeps `ledger.v6.backup.json` before materializing implicit File/public Net rights. v5 requires explicit `AuthorityStore.migrateV5()` first; v1–v4 are rejected. Historical destructive archives cannot recover data that the old runtime deleted.

```bash
node dist/check-cli.js examples/demo.linden
```

The compiler emits diagnostics and checked operations. Model/session compression follows the pinned Pi behavior: compaction is checked before ordinary prompts and after an Agent run, not after each tool in a running loop.
