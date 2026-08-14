# ST-BaiBai-Image（柏宝绘）阶段二：楼层生图卡片 — 定稿设计

> 状态：已定稿（2025-08 讨论确认），等待编码。
> 关联文档：`DESIGN.md`（总设计草案，本文件是其第 2.1 / 6 / 8 / 11 / 12.1 / 14.4 节的实现细化）。

## 0. 一句话方案

**显示侧正则在 markdown 转换之前把 `<bbi_image>...</bbi_image>` 整体消费掉，替换成空锚点 `<div data-bbi-slot=""></div>`；提示词侧同一 find 替换为空字符串（提示词永不进 DOM）；渲染事件触发后插件水合，用 Vue 把生图卡片渲染进锚点 div。**

## 1. 目标与形态

往聊天消息楼层（消息内部、tag 所在段落位置）注入可交互小界面，支持：

- 显示生成的图片
- 查看提示词（折叠 + 复制）
- 手动生图 / 重新生成 / 取消
- 多图历史翻页（◀ 2/5 ▶）
- 删除结果
- 提示词被编辑后标记 stale（旧图保留作历史）

楼层注入小界面是阶段二唯一合理形态：

- 原生 media 区做不到段落级定位（图片无法贴到 tag 所在段落）。
- 单独相册页丢掉位置锚点（用户不知道图片对应正文哪一段）。

## 2. 方案选型记录

### 2.1 候选方案

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 正则直接替换成占位 div | 显示侧正则把 tag 整体替换为 `<div data-bbi-slot=""></div>`，提示词侧替换为空 | ✅ 采用 |
| B. 参考项目 `tavern_helper_template` 的代码围栏模式 | 正则把 `<msg>` 包成代码围栏 → `pre:contains()` 定位 → 换 div → Teleport + render() 挂 Vue 组件 | ❌ 否决（见 2.2） |
| C. st-chatu8 的 DOM 扫描 + 模糊匹配 + 邻近插入 | tag 作为普通文本留在正文，渲染后 TreeWalker 遍历文本节点、模糊匹配定位、插入按钮/图片容器 | ❌ 否决（见 2.3） |
| D. 原生 media 区 / 独立相册页 | — | ❌ 否决（见 1） |

### 2.2 为什么否决参考项目的代码围栏方案

参考项目（`E:\tavern_helper_template-main\src\手机界面\index.ts`）的核心模式：

1. 正则把 `<msg>...</msg>` 包成代码围栏（内容留在 DOM 供二次解析）
2. `MESSAGE_UPDATED` 时 `pre:contains()` 定位
3. 换成 div，`h(Teleport, {to: div}) + render(vnode, 已移除的 pre)` 挂 Vue 组件
4. `teleportStyle()` 把 `head > style` 克隆进 document.head

否决原因：

- 它的内容需要留在 DOM 供二次解析，且 prompt 侧不清除；柏宝绘要求提示词在**显示路径与提示词路径都彻底隐藏**（DESIGN.md 2.1）。方案 A 在正则层就整体消费掉 tag，零泄漏。
- 参考项目在此处有轻微泄漏：重水合前未显式卸载旧 vnode。我们改为记录 (mesid, seq) → vnode 树，重水合前先 `render(null, container)`。

### 2.3 为什么否决 st-chatu8 的 DOM 扫描方案

st-chatu8（`third-party/st-chatu8`，智绘姬）的实作：

- tag（`[prompt]` 或 `image###...###`）作为普通文本留在正文，不替换成占位符。
- 监听 `CHARACTER_MESSAGE_RENDERED` / `USER_MESSAGE_RENDERED` / `MESSAGE_SWIPED` / `MESSAGE_EDITED` / `GENERATION_ENDED`。
- 渲染后：先清除自己上次注入的元素（`.image-tag-button` / `.st-chatu8-image-span` / `.st-chatu8-image-container` / `.st-chatu8-collapse-wrapper`）→ TreeWalker 遍历文本节点 + BR 拼出带偏移的 `logicalText` → `fuzzyMatchLine` 相似度评分定位 tag → 邻近插入按钮/图片容器 → `saveImageGroup` 按文本位置 key 持久化恢复。

否决原因：

- 它必须模糊匹配，是因为它的 tag 留在正文/DOM 且被 markdown 预处理污染（fixMarkdown 补引号、宏替换、引号处理），无法精确匹配原文。changelog 一串修复（"图片插入不再受 `<!-- -->` 文本影响"、"修复聊天记录可能被插件置空"、"修复正文不能切换图片"）都是这条路的代价。
- 我们的约束相反：tag 必须从显示路径消失。锚点由正则在 markdown 之前**精确**生成，定位零匹配成本，提示词从 `message.mes` 原文精确解析。

**但 st-chatu8 有三样东西值得抄**（已纳入本设计）：

1. **幂等清理模式**：注入前先 `querySelectorAll` 清掉自己的旧元素再注入。
2. **注入元素绕过 sanitizer**：按钮/容器是渲染后插入 live DOM 的，不经过 DOMPurify，class/样式随便用。我们的卡片水合进锚点后同样是"后插入"自由 DOM；只有空锚点本身过 sanitizer（因此锚点只用 data 属性，最小暴露面）。
3. **事件挂载并集**：新 AI 楼层渲染只发 `CHARACTER_MESSAGE_RENDERED`（script.js:3751/6644 等），编辑保存只发 `MESSAGE_UPDATED`（script.js:8381），两者都要挂（详见 §6.3）。

## 3. ST 1.18.0 渲染管线（源码实测事实）

```text
原始正文
  -> 宏替换（substituteParams）
  -> getRegexedString(mes, placement, {isMarkdown: true})   // script.js:1821
       markdownOnly 正则在 markdown 转换前的原始文本上执行
  -> quote/style 预处理 + fixMarkdown（power-user.js:429，auto_fix_generated_markdown 开启时）
       —— 会删格式符旁空格、奇数 * / " 行尾补字符，篡改 div 内文本内容
  -> showdown makeHtml（未开 parseHTML；hashHTMLBlocks / hashHTMLSpans 原样放行 HTML）
  -> DOMPurify.sanitize（ADD_TAGS:['custom-style']、MESSAGE_SANITIZE:true；chats.js:1910 钩子把 class 改写成 custom-* 前缀，data-* 不碰）
  -> 写入 .mes_text
```

### 3.1 由此推出的硬约束

| 约束 | 原因 |
|---|---|
| 锚点用 `data-bbi-slot` 属性，**不用 class** | DOMPurify 钩子会把 class 强制加 `custom-` 前缀，`.bbi_image` 等选择器失效 |
| 锚点必须为空元素 | `fixMarkdown` 会篡改锚点内的文本内容 |
| tag 原文不能留在 DOM | 宏替换、fixMarkdown、DOMPurify 都会改写它；且 prompt 会从显示路径泄漏回提示词路径 |
| 提示词解析只从 `message.mes` 原文 | 与插入时计算 promptHash 的输入精确一致，结果查找不失配 |

### 3.2 正则引擎（extensions/regex/engine.js）事实

- placement：0=MD_DISPLAY(已弃用) / 1=USER_INPUT / 2=AI_OUTPUT / 3=SLASH_COMMAND
- 生效条件：`(markdownOnly && isMarkdown) || (promptOnly && isPrompt) || (两者皆非)`
- 替换串支持 `$1` / `$<name>` / `{{match}}`（→ `$0`）
- 最终替换结果会过 `substituteParams` 宏替换
- 边缘风险：`power_user.encode_tags`（默认关）会把 div 尖括号编码掉导致锚点失效，可接受

## 4. 正则设计（两条托管脚本）

### 4.1 显示侧：`bbi-image-tag-slot`（markdownOnly）

```text
findRegex:     /<bbi_image>[\s\S]+?<\/bbi_image>/gi
replaceString: <div data-bbi-slot=""></div>
placement:     [2]（AI_OUTPUT；如支持用户手动 tag 则加入 1）
markdownOnly:  true
promptOnly:    false
```

### 4.2 提示词侧：`bbi-image-tag-hide`（promptOnly）

```text
findRegex:     同一 find（/ <bbi_image>[\s\S]+?<\/bbi_image> /gi）
replaceString: ''（空串）
markdownOnly:  false
promptOnly:    true
```

- 由现有 `bbi-image-tag-hide` 改造（src/st/imageTagRegex.ts）。
- 两条脚本用**固定 id** 注册，幂等迁移（`ensureImageTagRegexRegistered`）：检测到缺失/被改则重建，不重复添加。

## 5. 锚点与水合

### 5.1 锚点

```html
<div data-bbi-slot=""></div>
```

- 由显示侧正则生成，落在 tag 原本所在的段落位置。
- 空元素、无文本，`fixMarkdown` / 宏替换 / DOMPurify 均无法篡改其内部（没有内部）。
- 消息 DOM 中 `[data-bbi-slot]` 的出现顺序 = 该消息中 tag 的序号（第 N 个锚点 = 第 N 个 tag）。

### 5.2 水合流程（幂等）

```text
渲染事件触发（messageId）
  -> 定位楼层 .mes[mesid=N] 内的 .mes_text
  -> find('[data-bbi-slot]') 得到锚点列表（按 DOM 顺序）
  -> 从 context.chat[mesid].mes 用同一 find 正则解析出 tag 列表
  -> 第 i 个锚点 <-> 第 i 个 tag（精确对应）
  -> 每个锚点：
       1. 若已挂载（记录表 (mesid, seq) -> vnode）→ render(null, anchor) 显式卸载
       2. 从 message.extra 按 swipeId 分桶查找结果
       3. promptHash(当前 tag 原文) vs 结果.promptHash
           匹配 -> ready 卡片（图片 + 操作）
           不匹配 -> stale 卡片（新提示词 + 旧图标记为历史）
           无结果 -> pending 卡片（占位 + 手动生图按钮）
       4. render(h(Card, props), anchor) 挂载
```

### 5.3 提示词获取

- **提示词永远不进 DOM**。水合时已知 mesid + 槽位 DOM 顺序，从 `context.chat[mesid].mes` 解析第 N 个 tag 拿精确原文（约 5 行代码）。
- 用户提出的"tag 留在 DOM 方便获取"被否决，理由：
  1. `substituteParams` 宏替换会改写 tag 内容
  2. `fixMarkdown` 会篡改 tag 内容
  3. DOMPurify 会改写 class（tag 若用 class 标记）
  4. 提示词泄漏回显示路径，破坏 DESIGN.md 2.1 的隐藏要求

### 5.4 编辑同步（无需额外监听）

用户编辑楼层原文 → ST 全量重渲染（编辑保存路径 script.js:8381 前后）→ 正则在**新文本**上重新执行、锚点重建 → `MESSAGE_UPDATED` 触发 → 重水合读取已更新的 `chat[mesid].mes` → promptHash 比对 → stale。

不存在"已挂载卡片需增量感知 tag 变化"的场景：ST 的编辑/滑动/重新生成都会销毁并重建 `.mes_text`，锚点随每次渲染重建，水合随每次事件重建。两个候选方案（空锚点 / 内容锚点）在编辑感知上处于同一水位，但内容锚点方案会因 DOM 污染导致 hash 失配（见 3.1）。

## 6. 事件与生命周期

### 6.1 事件并集（st-chatu8 经验 + ST 实测）

| 事件 | 覆盖场景 | 来源 |
|---|---|---|
| `CHARACTER_MESSAGE_RENDERED` | 新 AI 楼层渲染（script.js:3751/3780/6644/6669/6691/6734/7657/9875） | 必需：新楼层生图卡片 |
| `USER_MESSAGE_RENDERED` | 用户楼层渲染（script.js:5863/5870） | 用户手动 tag |
| `MESSAGE_UPDATED` | 编辑保存 / updateMessageBlock（script.js:8287/8381） | 必需：编辑后 stale |
| `MESSAGE_SWIPED` | 滑动（script.js:10271 附近） | 换 swipe 重水合 |
| `MESSAGE_DELETED` | 删除楼层 | 清理 vnode 记录与 extra |
| `CHAT_CHANGED` | 切聊天 | 全量清理重水合 |

### 6.2 卸载

- 记录表：(chatId, mesid, swipeId, seq) → vnode。
- 重水合 / 删除 / 切聊天前 `render(null, container)` 显式卸载（修正参考项目的泄漏点）。
- 卡片在 shadow root 外部（light DOM），但 Vue 渲染器负责其事件绑定与更新，不受 shadow root 影响。

### 6.3 样式

- 卡片活在 light DOM，shadow root 样式够不着（参考项目 `teleportStyle()` 已验证）。
- 实现：插件把卡片所需样式副本注入 `document.head`（带命名前缀防冲突），与 shadow root 内现有 Vue app / 主题组件并存。
- 主题变量：优先用 ST CSS 变量（`--main-font-color` 等），自定义变量用 `--bbi-*` 前缀。

## 7. 结果存储层

### 7.1 结构

```text
message.extra.bbiImage = {
  [swipeId]: {
    [promptHash]: {
      generationId,          // 本次生成唯一 id
      prompt,                // 生成时使用的完整提示词（含负向/质量词）
      negativePrompt,
      seed, backend, model, workflow,   // 元信息
      imagePath / imageUrls, // ST media 落盘后的访问路径（见 7.3）
      status, createdAt,
    }
  }
}
```

- 按 swipeId 分桶：滑动互不污染，swipe 内容各自对应自己的结果。
- 键 = promptHash + generationId：同一提示词多次生成形成历史列表，卡片翻页浏览。
- promptHash stale 检测：水合时用当前 tag 原文重算 hash，不匹配则卡片标 stale，旧图保留为历史，不清除。

### 7.2 写入安全

- 沿用 `src/st/messageEdit.ts` 的 CAS 写回模式（读-改-写，防并发覆盖）。
- 写入后 `saveChatConditional()`（或等价持久化调用）落盘。

### 7.3 图片落盘（两层分离：二进制进文件系统，元数据进 extra）

**第一层：图片二进制 → ST 文件系统**

```text
ComfyUI 返回图片
  ├─ browser 直连模式：Blob（src/backends/comfyui.ts:299，带 revoke()）
  └─ server 代理模式：data URL（src/backends/comfyui.ts:243）
        │  统一转成 base64 字符串（blob -> arrayBuffer -> base64；data URL 去前缀）
        ▼
uploadFileAttachment(name, base64)   ← ST 现成导出函数（public/scripts/chats.js:276）
        │  内部 = POST /api/files/upload，body { name, data: base64 }
        ▼
服务端写入 data/<用户>/user/files/<name>（src/constants.js:43 files: 'user/files'）
        ▼
返回相对路径 /user/files/bbi/<chatId>/<swipeId>/<promptHash>-<generationId>.png
        │  浏览器 <img src> 直接显示（src/users.js:1218 静态服务 /user/files/*）
```

- 命名规范：`bbi/<chatId>/<swipeId>/<promptHash>-<generationId>.png`——可预测、同标签历史不冲突、后续可批量清理。
- base64 转换有约 1.37 倍内存开销，单张可接受。
- 落盘后与 blob 生命周期解耦：`revoke()` 照常执行或直接废弃，路径已持久化。
- **禁止 data URL / blob URL 进 extra**：
  - data URL 会膨胀聊天 JSON（几百 KB~几 MB/张），保存/加载全变慢
  - blob URL 刷新即失效，无法持久化
- 删除文件：`POST /api/files/delete`（body { path }，服务端校验必须在 files 目录内）。

**第二层：元数据 → message.extra（聊天 JSON，只有几 KB 指针）**

```json
{
  "bbiImage": {
    "0": {                       // swipeId 分桶
      "a3f9c2...": {             // promptHash
        "generationId": "g_1723...",
        "path": "/user/files/bbi/chat-12/0/a3f9c2-g_1723.png",  // 指向第一层
        "prompt": "...", "negativePrompt": "...",
        "seed": 42, "backend": "comfyui", "model": "...",
        "status": "ready", "createdAt": 1723...
      }
    }
  }
}
```

### 7.4 为什么选 ST files（备选否决记录）

| 方案 | 问题 |
|---|---|
| data URL 进 extra | 聊天 JSON 膨胀（几百 KB~几 MB/张），保存/加载全变慢 |
| blob URL | 刷新页面即失效，无法持久化 |
| 外部 ComfyUI URL（`/view?filename=`） | 依赖 ComfyUI 服务时刻在线、跨域/鉴权问题、换设备失效 |
| **ST files（采用）** | 与 ST 数据目录同生命周期：刷新/重启/换设备（同 data 目录）都有效；聊天 JSON 只存几 KB 指针；删除走现成 `/api/files/delete` |

### 7.5 生命周期衔接

- **显示**：水合时从 extra 拿 `path` → `<img>` 直接引用，无需重新上传。
- **历史翻页**：同 promptHash 下多个 generationId 各有一条记录、各有自己的文件。
- **删除结果**：`/api/files/delete` 删文件 + extra 桶内删条目。
- **孤儿清理**：删除中断会留垃圾文件，提供"扫描 `user/files/bbi` 清理 extra 无引用文件"（st-chatu8 changelog 有"删除储存在酒馆的图片会有空白幽灵图片"的教训，需预防）。
- **编码前实测项**：`uploadFileAttachment` 在 1.18 的调用方式、`/api/files/delete` 参数格式、extra 在 swipe 切换时的持久化行为。

### 7.6 与阶段一现状的衔接

- 现 `src/backends/comfyui.ts` 测试生图：browser 模式返回 Blob（带 `revoke()`，生命周期归调用方），server 模式返回 data URL（:243）。
- 落盘时统一：Blob → arrayBuffer → base64；data URL 去掉 `data:image/...;base64,` 前缀直接用。
- 落盘成功后再写 extra（先文件后指针，避免孤儿指针）；写 extra 失败则文件留作孤儿，由 7.5 的清理兜底。

## 8. 卡片 UI（状态机）

### 8.1 状态

```text
pending    —— 有 tag 无结果（占位 + "生成"按钮）
generating —— 请求在途（进度/取消按钮；任务身份 = chatId+floor+swipeId+seq+promptHash）
ready      —— 有结果且 hash 匹配（图片 + 操作栏）
stale      —— 有结果但提示词已改（新提示词 + 旧图标"已过时"，可重新生成）
error      —— 生成失败（错误信息 + 重试）
cancelled  —— 用户取消（可重新生成）
```

### 8.2 交互

| 操作 | 行为 |
|---|---|
| 查看提示词 | 折叠面板展示当前 tag 原文 + 复制按钮 |
| 生成 | 提交 tag 原文给后端（%prompt% 占位符链路，见 src/backends/comfyui.ts） |
| 重新生成 | 同提示词新 generationId，加入历史 |
| 取消 | 中止任务（复用后端轮询任务的取消能力） |
| 翻页 | ◀ 2/5 ▶ 在同一 tag 的历史结果间切换 |
| 删除 | 删除当前结果（DOM 卡片 + extra 桶内条目） |

### 8.3 挂载

- 复用 shadow root 里现有 Vue app / reactive store / 主题组件（模块级单例 import，不依赖 provide/inject，故 Teleport 非必需）。
- `render(h(Card, {props}), anchor)` 直接渲染到锚点；参考项目用 `h(Teleport, {to})` 亦可，语义等价。
- 若未来卡片需要共享 app 的 provide/inject，改为 Teleport 写法即可（组件树仍在原 app 内）。

## 9. 设置补充（DESIGN.md 6.1 细化）

在现有 `ComfyUISettings`（url/workflow/requestMode）基础上，为每个后端补充：

- 负向词（negative_prompt 占位符）
- 质量词（固定前置/后置质量词）
- 种子策略（随机 / 固定 / 上次种子 ±）

## 10. 编码顺序

1. `src/st/imageTagRegex.ts`：拆分两条托管正则（固定 id 幂等迁移），先做 `bbi-image-tag-slot`（显示侧），验证锚点产出
2. 水合框架：事件并集 + `.mes[mesid=N] .mes_text` 定位 + 锚点/tag 按序配对 + 幂等挂载/卸载
3. 结果存储层：`message.extra` 分桶 + CAS 写回 + ST media 上传 + promptHash stale 检测
4. 设置补齐：每后端负向词/质量词/种子策略
5. 卡片 UI：状态机 + 查看提示词 + 生成/重新生成/取消 + 历史翻页 + 删除；`render()` 挂载、显式卸载、样式副本进 document.head
6. 编码前实测项：`MESSAGE_UPDATED` 载荷、media 上传接口、`message.extra` 持久化行为（ST 1.18.0 实际行为确认）

## 11. 关键源码位置备忘

| 位置 | 内容 |
|---|---|
| `D:/1/SillyTavern/public/script.js:1821` | `getRegexedString` 调用（markdownOnly 正则执行点） |
| `D:/1/SillyTavern/public/script.js:8287` | `updateMessageBlock` 内 `MESSAGE_UPDATED` emit |
| `D:/1/SillyTavern/public/script.js:8381` | 编辑器保存后 `MESSAGE_UPDATED` emit |
| `D:/1/SillyTavern/public/script.js:3751/3780/6644 等` | `CHARACTER_MESSAGE_RENDERED` emit |
| `D:/1/SillyTavern/public/script.js:5863/5870` | `USER_MESSAGE_RENDERED` emit |
| `D:/1/SillyTavern/public/power-user.js:429` | `fixMarkdown`（篡改 div 内文本） |
| `D:/1/SillyTavern/public/scripts/extensions/regex/engine.js` | 正则引擎（placement/生效条件/替换语法） |
| `D:/1/SillyTavern/public/scripts/chats.js:276` | `uploadFileAttachment(fileName, base64)` 现成上传函数（POST /api/files/upload） |
| `D:/1/SillyTavern/src/endpoints/files.js:28` | `POST /api/files/upload`（body `{name, data: base64}`，返回 `{path}`）；:56 delete |
| `D:/1/SillyTavern/src/constants.js:43` | `files: 'user/files'` 存储目录 |
| `D:/1/SillyTavern/src/users.js:1218` | `/user/files/*` 静态服务 |
| `D:/1/SillyTavern/public/scripts/extensions/third-party/st-chatu8` | 参考：幂等清理、后注入绕过 sanitizer、事件并集 |
| `E:\tavern_helper_template-main\src\手机界面\index.ts` | 参考：Teleport+render() 挂载、teleportStyle() |
