# Linden implementation artifact

This is a source-only, history-free snapshot of the Linden language and runtime. It excludes experiment runs, prompts, session state, private data, and generated binaries.

This snapshot reflects the current implementation, which uses ledger schema v6. The paper's RQ1/RQ2 measurements were recorded on an earlier, modified schema-v5 working tree. Their outcome and timing records are preserved in the separate supplement, but this repository is not an exact reconstruction of that historical tree and should not be claimed to reproduce those particular measurements byte-for-byte.

Use Node.js >=22.19 and Rust/Cargo. Run `npm ci`, `npm run check`, `npm test`, then `npm run build`. Linux/WSL physical-sandbox tests require Bubblewrap and socat; see `README.md`. The lockfile pins the Pi integration.

The evaluation ledger and recomputation instructions are in the separate supplement.

No license file was present in the source checkout. Choose a license before public release; this local snapshot does not invent one.
