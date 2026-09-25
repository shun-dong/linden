# Linden

Linden is a base-scoped, single-writer authority runtime for Pi `0.84.2`. The implementation combines a static compiler, schema-v6 `Delta/Gamma` session ledger, native File gateways, sandboxed Bash, Web host authority, linear Messages, and Pi session-tree control. The formal account is in the paper; this standalone repository contains the implementation only.

## Implemented core

- Every launch creates a stable `session:<UUID>` unless `--session` resumes an existing session. Each session has an immutable canonical base and an independent schema-v6 ledger.
- File identities are readable: exact atoms are `file:<canonical-absolute-path>` and regions add a trailing `/`. There is no public `Path` resource kind.
- Human implicitly owns unmaterialized File authority inside the base and all public Web authority. Top-level Agents receive only a cwd read snapshot by default; Agent subspawns inherit their parent's effective File reads.
- Authority-bearing resource arguments accept only typed `file:`/`web:` references. A File address may be absolute or use `~`, `.`, `./`, or a relative address after `file:`; it canonicalizes through the nearest existing ancestor before base/private-state checks.
- `give` and direct-parent `get` transfer ownership atomically with no persisted in-transit state. File regions, exact/Absent Files, and Web host selectors use the same direct-edge rule.
- Compiler-owned `deriveJudgment` is the runtime gateway entry; runtime adapters realize checked values and effects without a shadow/reference permission implementation.
- Versioned File state supports branching checkout, content-addressed blobs, prepare/commit journals, recovery, and divergence fail-closed behavior.
- Pi `read`, `write`, `edit`, and `bash` are mediated. Mailbox, assistant final, stop/steer, attach/detach, archive, checkpoint, and direct-parent rewind remain session-scoped.

## Setup and verification

Node `>=22.19` and Pi `0.84.2` are required. Linux/WSL physical sandbox tests additionally require `bubblewrap`, `socat`, and `rg`.

```bash
npm install
npm run check
npm test
npm run build
```

Windows runs compiler, store, CLI, and non-sandbox tests. Bubblewrap integration is Linux/WSL-only. `postinstall` applies the detachable-UI patch only to Pi `0.84.2`.

## Sessions and control plane

```bash
# New session; base defaults to cwd
node dist/cli.js [base]

# Resume by full ID or unique UUID suffix
node dist/cli.js [base] --session <id-or-suffix>
```

The base must already exist and cannot change after creation. `cd` changes only the CLI cwd. Sessions whose bases are equal or ancestor/descendant cannot be active together; sibling and disjoint bases can run concurrently.

Useful control-plane commands:

```text
linden> cd src
linden> :participants
linden> :authority
linden> :spawn review --give &file:./
linden> :give review file:./parser/
linden> :get review file:./parser/
linden> :attach <agent-id-or-unique-Pi-suffix>
linden> :mailbox
linden> :resume
```

`:spawn` creates a direct human child and enters its Pi UI. `--no-cwd-read` disables its default cwd-region read snapshot. Inside Pi, `/exit` returns to `linden>` without aborting an in-flight turn; `/quit` retains Pi's process-exit meaning. `:resume` hot-switches only when Bash, attach, and all Agents are idle.

## Authority semantics

- Complete ownership is unique within an active session. A read pointer never grants write authority.
- Moving a nested File region or exact File subtracts it from the former owner's broader region using normalized `include - exclusions` expressions.
- A File-region read pointer denotes the whole covered set, including exact Files and nested regions materialized before or after the grant.
- Native overlapping reads wait for a native write/edit to commit and observe the new state. Reads during a long Bash command retain the intentional pre-Bash committed snapshot behavior (`stale=true`).
- Human Web authority is implicit. Agents receive no Web by default; grant `web:api.example.com/` or `web:*.example.com/`. Web authority does not support URL-path identities or promise HTTPS path enforcement.
- Network adapters always reject private, loopback, link-local, reserved, and IPv4-mapped targets and revalidate resolved addresses.
- `&>>Agent` is limited to `listen`, `send`, `steer`, and `stop`; it does not grant `receive`, `log`, `rewind`, `give`, or `get`. `rewind` accepts only a direct child.
- Rewind changes Pi context only. Ownership, mailbox consumption, File current versions, subagents, and external effects are not resurrected.

## Persistent layout

```text
~/.linden/
├── sessions/
│   └── <session-uuid>/
│       ├── session.json
│       ├── ledger.json
│       ├── process-state.json
│       ├── blobs/
│       ├── journal/
│       ├── mail-payloads/
│       └── pi-sessions/
└── active/
```

`session.json` stores schema, full session ID, immutable base, creation time, and last-open time. Active leases contain PID/process-token/heartbeat data and stale leases are reclaimed. Ledger schemas v1–v4 are rejected; v5 requires explicit migration before opening.

## Compiler CLI

```bash
node dist/check-cli.js examples/demo.linden
```

The compiler emits source-spanned structured diagnostics and Checked IR with participant, atomic operation, consumed/preserved/produced typed identities, direct-edge/ancestor dependencies, and scoped state/message references. `read` and `stat` use the internal `State_File = Absent | Present(String)` result type.

## Filesystem boundary

Linden supports regular-file and File-region authority with nearest-existing-ancestor canonicalization. Symlink escape, hardlink/cross-region behavior that cannot be proven safe, and private state access fail closed. On Linux/WSL, delegated existing exact Files are over-mounted read-only; delegated Absent Files use identity-checked placeholders and are restored only if unchanged.
