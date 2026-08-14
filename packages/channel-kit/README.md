# dsh-channel-kit

The shared grunt-work layer for channels: pure functions for the six grunt-work modules,
with no dependency on cordis or dsh-channel.

## Modules

| Module | File | Purpose |
|---|---|---|
| chunk | `chunk.ts` | markdown block splitting, fenced code blocks kept atomic, re-fencing on oversized hard splits, `（i/n）` prefix convergence |
| merge | `merge.ts` | burst-merge reducer: command/media bypass, `..`/`!!` suffixes, ack-long |
| router | `router.ts` | pure decision from platform session → dsh session |
| approval-render | `approval-render.ts` | approval button/numbered-text rendering and reply parsing |
| store | `store.ts` / `store/json-file.ts` | `ChannelStore` interface, in-memory implementation, JSON file implementation (tmp+rename atomic writes, 500ms debounce) |
| format | `format.ts` | Markdown → `plain` / `markdown` / `html` three-tier degradation |
| promptHint | `prompt-hint.ts` | platform prompt segment, injected into the agent's scoped system prompt |

## Usage

```ts
import { chunkText, mergeReduce, renderForTier, route } from 'dsh-channel-kit'
```

See the interface comments at the top of each source file and `test/*.test.ts`.
