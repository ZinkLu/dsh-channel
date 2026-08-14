# dsh-channel-kit

渠道公共脏活层：六件脏活的纯函数，不依赖 cordis，不依赖 dsh-channel。

## 模块

| 模块 | 文件 | 功能 |
|---|---|---|
| chunk | `chunk.ts` | markdown 块切分、围栏代码块原子、超长硬切补围栏、`（i/n）` 前缀收敛 |
| merge | `merge.ts` | 连发合并 reducer：命令/媒体旁路、`..`/`!!` 后缀、ack-long |
| router | `router.ts` | 平台会话 → dsh session 的纯决策 |
| approval-render | `approval-render.ts` | 审批按钮/编号文本渲染与回复解析 |
| store | `store.ts` / `store/json-file.ts` | `ChannelStore` 接口、内存实现、JSON 文件实现（tmp+rename 原子写，500ms 防抖） |
| format | `format.ts` | Markdown → `plain` / `markdown` / `html` 三档降级 |
| promptHint | `prompt-hint.ts` | 平台提示段，注入 agent 作用域 system prompt |

## 使用

```ts
import { chunkText, mergeReduce, renderForTier, route } from 'dsh-channel-kit'
```

详见各源码文件顶部的接口注释与 `test/*.test.ts`。
