# ST-BaiBai-Image(柏宝绘)架构说明

> 给新聊天的 AI 快速定位代码用。先读本文,再按「任务定位索引」找文件;深入设计取舍见
> `DESIGN.md`(总设计草案)与 `DESIGN-FLOOR-UI.md`(楼层生图卡片定稿)。

## 1. 这是什么

柏宝绘是 SillyTavern(ST)的第三方生图扩展:

- 新 AI 正文落地后,**独立**发起一次 LLM 请求,判断哪些画面值得画、产出 danbooru tag,
  把 tag 以 `<bbi_image>...</bbi_image>` 形式插进正文(用户可手改);
- 楼层里 tag 位置渲染一张「生图卡片」,点生成即调用出图后端(ComfyUI / NovelAI),
  结果图片落盘到 ST 文件系统,元数据存消息 extra,支持历史翻页/重新生成/stale 提示;
- 自带一个全屏设置窗口(渠道、角色管理、设置),整个 UI 活在 **shadow DOM** 里,与 ST 样式隔离。

技术栈:Vite + Vue 3(script setup)+ TypeScript,Vitest 单测。产物 `dist/index.js` + `dist/index.css`,
manifest.json 的版本号由 `scripts/sync-version.mjs` 在 build 前自动同步(package.json → manifest)。

## 2. 目录总览

```
src/
├── index.ts           # 入口:挂载 shadow root、注入 CSS、等 ST 就绪后依次 bind 各子系统
├── App.vue            # 主窗口(遮罩/窗口/导航/分页),弹窗 Teleport 宿主,移动端抽屉手势
├── st/                # ★ 与 ST 宿主唯一的接触面(其余目录一律经 getContext 间接用 ST)
│   ├── context.ts     # getContext() 类型封装;动态取 checkWorldInfo、ST-Prompt-Template
│   ├── imageTagRegex.ts  # 托管两条正则:<bbi_image> 显示侧→空锚点 div,提示词侧→空串
│   ├── messageEdit.ts # CAS 写回消息正文(applyMessageText),竞态保护
│   ├── keyboard.ts    # shadow 内编辑控件方向键不冒泡到 ST 全局快捷键
│   ├── clipboard.ts   # 复制到剪贴板统一入口(失败 toast;卡片/灯箱/历史页共用)
│   └── iconFallback.ts# 注入按钮的字体图标兜底(防美化主题清空图标)
├── state/             # 全局状态与持久化
│   ├── settings.ts    # ★ 设置模型 + hydrate/persist/迁移 + 跨插件共享渠道存储
│   ├── ui.ts          # 窗口开关/主题/导航/悬浮球;activePage 存 localStorage
│   │                  # (纯浏览态都走 localStorage:渠道页签记忆同理,在 backend/index.vue)
│   ├── history.ts     # 请求历史(LLM 推理+生图)模块级内存 store,刻意不持久化
│   ├── charTags.ts    # 角色固定外貌库:本聊天基线(chatMetadata)+ AI 楼层增量(消息 extra),
│   │                  # 全局库经 setGlobalCharTagSource 注入合并;锁定名拦截 AI changes
│   └── globalCharTags.ts # 全局角色库(extensionSettings,跨聊天/跨设备):仅手动维护的冻结模板,
│                      # AI 永不可写;提升为全局/复制回本聊天两条迁移路径
├── api/
│   └── client.ts      # LLM 请求:副 API 走 ST 服务端代理 / 跟随主 API 走 generateRaw
├── autoTag/           # ★ 链路 A:自动生 tag(独立 LLM 请求 → 协议校验 → 注入正文)
│   ├── runner.ts      # 事件监听、去重、重试、编排(入口)
│   ├── generationGate.ts # 生成门:把自动 tag 与真实生成配对(GENERATION_STARTED 武装 → 最终 RENDERED 消费)
│   ├── prompt.ts      # 组装消息:破限/角色/人设/世界书/规范/协议/思维链/预填充
│   ├── protocol.ts    # 段尾位置 ID、JSON 严格解析校验、tag 注入格式
│   ├── clean.ts       # 历史/目标正文清洗(共享排除标签;历史保留 bbi_image)
│   ├── context.ts     # 世界书激活(条目级渲染:展宏+EJS)、角色卡、user 人设
│   ├── bookMemory.ts  # 读「柏宝书」全局 API,解析成角色参考块
│   └── charAnchors.ts # 角色库:库文本注入 → 兜底替换残留 @占位符(AI 照抄字段值,不用占位符)
├── backends/          # 出图后端(链路 B 的生成端)+ 共享尺寸工具
│   ├── comfyui.ts     # ComfyUI:工作流模板 %占位符% 渲染、浏览器直连/ST 转发自动回退
│   ├── comfyTemplates.ts # 简易模式:模板族(checkpoint/flux/anima) + 参数组装 API JSON(无占位符)
│   ├── comfyObjectInfo.ts # 拉模型/LoRA/采样器列表(直连 /object_info,回退 ST 转发四个端点)
│   ├── comfyWorkflowAssistant.ts # AI 自动定位工作流节点(片段 ID 协议,不复制原文)
│   ├── nai.ts         # NovelAI:参数构造、vibe 编码/叠加、画师串前置拼装、.naiv4vibe 导入导出
│   ├── chatu8Vibe.ts  # 从智绘姬(st-chatu8)只读导入 vibe / 画师串预设
│   │                  # (collect/detect/import 纯函数三件套,绝不写回智绘姬)
│   ├── vibeGroups.ts  # Vibe 分组纯逻辑(装箱 key/归拢/搜索/启用集合判定)
│   └── size.ts        # 画幅方向归一 / 尺寸解析 / 按方向取配置(刻意不 import settings)
├── floor/             # ★ 链路 B:楼层生图卡片
│   ├── hydrate.ts     # 渲染事件 → 锚点×tag 配对 → 每锚点 attachShadow → Vue 卡片挂载(幂等)
│   ├── Card.vue       # 卡片本体(**纯展示层**,运行态在 genState.ts)+ 历史翻页
│   ├── genState.ts    # ★ 生成运行态 store(模块级,跨卡片重建存活)——改卡片状态先读它
│   ├── genQueue.ts    # NAI 并发闸门(ComfyUI 靠服务端队列,不经过这里)
│   ├── Lightbox.vue   # 图片放大层(含长按保存的三条约束,改前必读顶部注释)
│   ├── lightbox.ts    # 命令式打开灯箱(挂插件 shadow root,非卡片 shadow)
│   ├── download.ts    # 另存图片(卡片右上角与灯箱共用,同源文件走 <a download>)
│   ├── storage.ts     # 结果存储:extra 元数据(swipeId→promptHash→历史)+ 文件命名
│   ├── upload.ts      # ST /api/files/upload|delete 封装(不用未公开的 uploadFileAttachment)
│   ├── autoGenerate.ts# 「写 tag 后自动出图」标记握手(runner ↔ Card onMounted)
│   ├── actionButton.ts# 楼层「生成生图 tag」按钮注入(MutationObserver 幂等)
│   ├── registry.ts    # 槽位挂载记录表(chatId|mesid|swipeId|seq → shadow root/vnode)
│   ├── cardStyles.ts  # 构造共享 CSSStyleSheet(theme.css 选择器改写到 :host + card.css)
│   └── card.css       # 卡片样式(取 --bbi-* 令牌,与设置窗口同一套设计语言)
├── pages/             # 主窗口的分页(注册表在 pages/registry.ts)
│   ├── backend/index.vue      # 「渠道」页:页签(webui 已隐藏)+ 各后端面板
│   │   └── panels/            # ComfyUIPanel / NaiPanel / WebUIPanel(隐藏,代码保留)
│   ├── characters/index.vue   # 「角色管理」页:全局/本聊天两区卡片式外貌库 CRUD + 历史回滚
│   ├── gallery/index.vue      # 「图库」页:占位(制作中)。定为依赖柏宝库的可选增强页,接口成型后落地
│   ├── history/index.vue      # 「请求历史」页:调试辅助(LLM 提示词/响应/生图元信息)
│   └── settings/index.vue     # 「设置」页:渠道管理/自动 tag/提示词编辑/界面偏好(最大页)
├── components/       # 通用组件:BbiSelect/BbiCombo/BbiTextarea/Collapsible/ConfirmDialog/FloatingOrb/Icon/ModalMask/NavBar
│                     # (BbiCombo = 可输入可过滤下拉,与副 API 模型框同交互,菜单 Teleport 防裁剪)
├── styles/           # base.css(全局基础样式)、theme.css(主题变量,data-theme 切换)
├── menu.ts           # 魔杖菜单入口注入(轮询等懒加载)
├── topbar.ts         # ST 顶栏快速打开按钮(受 ui.showTopBar 开关控制)
└── version.ts        # 版本号(__BBI_VERSION__)+ 带 ver 的资源 URL
└── update.ts         # 更新检测:远端 manifest 版本对比 + /api/extensions/update 自动更新
```

## 3. 启动与挂载(读 index.ts)

1. `mount()`:在 body 建 `#bbi-app-host`(light DOM,`display:contents`),用 `INHERITED_RESET`
   内联 `!important` 钉死可继承排版属性,切断 ST 样式继承;Vue 应用整体挂进它的 **shadow root**;
   `dist/index.css` 以 `<link>` 注入 shadow root —— 样式双向隔离。
2. `$(() => ...)`:挂载应用、注入魔杖菜单入口、按开关同步顶栏按钮。
3. `hydrateWhenReady()`:轮询 `window.SillyTavern.getContext`(最多 ~20s),就绪后依次:
   `hydrateSettings()` → `bindCharTagSync()` → `ensureImageTagRegexRegistered()` →
   `bindAutoTagging()` → `bindFloorHydration()` → `bindTagActionButtons()` → `checkForUpdate()`
   (每会话只查一次远端版本,不阻塞其余初始化)。
   各 bind 函数均**幂等**(内部 `bound` 标志),可安全重复调用。

新增「启动时要做的绑定」→ 在 `hydrateWhenReady` 里加一行,并让绑定函数幂等。

## 4. 与 ST 宿主的接触面(st/ 目录)

**原则:除了 `st/` 目录,任何模块不得直接摸 ST 内部。** 具体接触点:

| 接触点 | 位置 | 说明 |
|---|---|---|
| `SillyTavern.getContext()` | st/context.ts | 唯一上下文入口,ST 未就绪返回 null,调用方轮询/降级 |
| `extensionSettings['baibai_image']` | state/settings.ts | 本插件设置(全局,跨设备同步) |
| `extensionSettings['baibai_api_channels']` | state/settings.ts | 跨「柏宝」插件共享的副 API 渠道(revision + 广播事件同步) |
| `extensionSettings.regex` | st/imageTagRegex.ts | 托管两条正则(固定 id,幂等注册/覆盖) |
| `chatMetadata['baibai_image_char_tags']` | state/charTags.ts | 角色库**本聊天手动基线**;AI 自动变化存各消息 extra `bbiCharChanges` |
| `extensionSettings['baibai_image_char_global']` | state/globalCharTags.ts | **全局角色库**(跨聊天,revision + 广播事件);仅手动维护,AI changes 按锁定名丢弃 |
| ST 事件 | 各 bind 处 | `CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_DELETED / CHAT_CHANGED` |
| `generateRaw` | api/client.ts | 跟随主 API 的一次性补全(ST 稳定 API) |
| `getWorldInfoPrompt` / 动态 import `checkWorldInfo` | autoTag/context.ts | 世界书激活(后者拿条目对象可逐条渲染;取不到自动降级前者) |
| `globalThis.EjsTemplate`(ST-Prompt-Template) | autoTag/context.ts | 世界书条目 EJS 执行(未装则降级) |
| `globalThis.STBaiBaiBook` | autoTag/bookMemory.ts | 柏宝书角色状态(apiVersion 1;不可用返回 null 降级) |
| HTTP 代理 | api/client.ts、backends/comfyui.ts、floor/upload.ts | `/api/backends/chat-completions/generate`、`/api/backends/chat-completions/status`、`/api/sd/comfy/*`、`/api/files/upload|delete` |
| 扩展更新 API | src/update.ts | `GET /api/extensions/discover`(查类型)+ `POST /api/extensions/update`(自动更新);远端版本读 GitHub raw manifest.json(8s 超时,失败静默) |
| 注入 DOM | menu.ts、topbar.ts、floor/actionButton.ts | 魔杖菜单 / 顶栏按钮 / 楼层按钮(不进 shadow) |

注意:三处 UI 的隔离层次不同,样式约定各不一样 ——
- 设置窗口:整个 Vue 应用挂在一个大 shadow root(`#bbi-app-host`),样式走 dist/index.css;
- 楼层卡片:每个锚点各自 attachShadow(见 §6),样式走 cardStyles.ts 的共享 CSSStyleSheet;
- 注入按钮(魔杖/顶栏/楼层按钮):纯 DOM、无 shadow,样式直接吃 ST 的。

## 5. 链路 A:自动生 tag(autoTag/)

触发:与 ST 真实生成配对,不信任渲染类型字符串 —— `GENERATION_STARTED` 时 `beginGeneration`
(过滤 dryRun/quiet/impersonate,记 chatId+type),最终 `CHARACTER_MESSAGE_RENDERED` 时
`consumeGeneration` 同 run 同聊天才消费并调度 `runForFloor`(setTimeout 0 等 ST 内部同步完,
期间换聊天则作废)。
**坑:GENERATION_ENDED 不得清 gate**——ST 会在最终 `CHARACTER_MESSAGE_RENDERED` 之前先发
ENDED,清了 gate 自动 tag 就永不触发(0.1.15 修);只有 `GENERATION_STOPPED`(用户中断)/
`CHAT_CHANGED` 才清。runner 内所有跳过路径都有 `[BBI][AutoTagDebug]` 诊断日志,排查触发
问题时看控制台即可定位是哪一步拦的。

```
runForFloor(floor, opts)
  1. 过滤:仅 AI 故事楼;已有 <bbi_image> 且非手动 replace 则跳过
  2. 身份去重:chatId\0floor\0swipeId\0textHash → processed Set;手动(manual)绕过
  3. 每楼一个 AbortController:同楼新任务 abort 旧任务;CHAT_CHANGED 全量取消
  4. 装配上下文:
     - bookMemory.readBookMemory  → 柏宝书角色参考块(可 null)
     - charAnchors.resolveCharAnchors → 库文本(纯本地渲染,无请求;空库返回 text=null)
     - prompt.buildAutoTagMessages → 消息数组(见下)
  5. 请求:getTagGenChannel() 有指派渠道 → requestCompletion(服务端代理);
     否则 requestViaMainApi(generateRaw)。**每楼只此一次请求** —— 建档与选图同属一次
     推理:先在 changes 里确立新角色外貌,再在同一次输出的 tag 里 @引用它并围绕它补
     其余 tag。(旧版另有一次「中文外貌 → 字段」转换请求,已删:柏宝书的中文 desc 本就
     随角色参考块发给主请求,主请求还多了世界书/角色卡/正文佐证,判断更准。)
  6. 重试循环:retryCount 次(请求异常 / 解析抛错都重试;abort 不消耗;「无画面」不算失败)
  7. protocol.parseImagePlan 严格校验(JSON 结构/目标位置 ID/禁含子标签/size 宽容降级竖屏);
     changes 全程宽容:单条坏只丢这条,绝不连累 images —— 漏一个角色档案只是它本轮没锚定,
     为它作废整次输出会连图一起没有。图片数按 `minImages～maxImages` 范围:超上限本地硬截断,
     少于下限(>0 时)抛错交给重试循环 —— 下限是用户明确要求,宁可重试也不交残缺结果。
     每图可选 `characters`(V5 原生多角色提示,≤32 条,name/tag/nl,宽容解析单条坏只丢这条),
     注入时序列化进 `<characters>…</characters>` 子标签;V5 下建档(new)必须带 nl,否则 runner 抛错重试
  8. changes 与柏宝书建档一起转成楼层增量 ops(extra 的 bbiCharChanges),不提前落库
  9. @占位符兜底替换:applyPositionedCharRefs 把 tag/nl 里残留的 @角色名 换成「基线 + 本楼
     ops 重放」后的库 tag。**建档(new)全楼生效**——新角色的固定外貌是本楼全程成立的事实;
     **永久变化(set)才按位置门控**,染发之前的图片用旧档。未知占位符剥除并 toast 告警。
     (v0.1.2 起主路径已撤:AI 改为直接照抄库中字段值,见 §7 角色库段——多角色多次展开
     会重复外貌导致重叠躯干,tag 预算也无法执行;applyCharRefs 系函数保留为兜底)
 10. protocol.injectImageTags 按位置 ID 映射在原始物理行后插入
     <bbi_image>tag<nl>…</nl><negative>…</negative><size>…</size></bbi_image>
 11. 若 autoGenerate 开:先 markForAutoGenerate 每个新槽位(见链路 B 握手)
 12. messageEdit.applyMessageText CAS 写回(正文 + extra 增量一体;swipe/聊天任一变化即放弃,
     成功才 recomputeCharTags;失败撤销标记;仅 changes 无图片也走写回)
```

消息顺序(prompt.ts 固定):破限 system → 角色卡 system → persona system → 世界书 system →
后端规范 system(ComfyUI/NAI 内置 spec,`{{nl}}` 宏按「生成自然语言」开关展开)→ 固定协议
(身份定义 + 输出契约:一个 `<thinking>` 块和一个 JSON 对象,JSON 含 images + changes)→ 思维链 system → user(角色参考 + 角色库 + 清洗后的最近 N 个 AI 故事楼及其间 user 楼 + 带段尾位置 ID 的目标正文)
→ assistant 预填充(`<thinking>`,渠道关闭 prefill 时由 client 丢弃)。

全部可编辑提示词(破限/规范/思维链/预填充)在 `state/settings.ts` 有内置默认常量
(`DEFAULT_*_PROMPT`/`DEFAULT_*_SPEC`),留空回落默认 —— 改默认提示词内容先看这里。

## 6. 链路 B:楼层卡片与出图(floor/ + backends/)

**显示原理(st/imageTagRegex.ts)**:托管正则 `bbi-image-tag-slot`(markdownOnly)把
`<bbi_image>…</bbi_image>` 在显示路径替换成空锚点 `<div data-bbi-slot=""></div>`;
`bbi-image-tag-hide`(promptOnly)在提示词路径替换成空串 —— tag 永不进 DOM、永不进提示词。

**水合(hydrate.ts)**:渲染事件(CHARACTER/USER_MESSAGE_RENDERED、MESSAGE_UPDATED、MESSAGE_SWIPED)→
定位 `.mes[mesid] .mes_text` → `parseImageTags(message.mes)` 与 DOM 锚点**按序配对** →
每个锚点 `attachShadow` 后 `render(h(Card,...), shadowRoot)`,记录进 `SlotRegistry`(key = chatId|mesid|swipeId|seq)。
重水合前先 `render(null, container)` 显式卸载,全程幂等。MESSAGE_DELETED / CHAT_CHANGED 全量重建。

**卡片为什么在 shadow DOM 里**:楼层活在 ST 的 light DOM,ST 全局样式与用户装的美化主题
会直接改到卡片上。每个锚点各自 `attachShadow` → 样式双向隔离(与 index.ts 主窗口同构,
只是从「一个大 host」变成「每槽位一个小 host」)。两点注意:
- **可继承属性**(font/color/line-height…)仍穿透 shadow 边界 → `CARD_INHERITED_RESET` 在 host 上钉死;
- **自定义属性**也穿透 → 故 `theme.css` 的 `data-theme='st'` 仍能取到宿主 `--SmartTheme*`。
  样式经 `adoptedStyleSheets` 共享**同一个** CSSStyleSheet 对象(cardStyles.ts),N 张卡零重复。
  设置页 0.1.9 起移除「楼层卡片主题」选择项(卡片无边框化后恒跟随 ST 主题),但
  `settings.ui.cardTheme` 字段与 hydrate 的读取保留 —— 旧用户已设的值继续生效,别当死代码删。

**卡片状态机(Card.vue + genState.ts)**:
- **运行态**(genState.ts 的模块级 reactive Map,key 同上):`queued / generating / error`
  —— **必须放在组件外**。差分水合下同锚点卡片是 props patch 不重挂,但锚点一旦被 ST 重渲染
  重建,组件照样整体重建;reconcileGen 也因此从 onMounted 挪到 `watch(hash, immediate)`
  (旧版重挂式水合里 onMounted 必跑,差分下不一定)。运行态若存组件 ref,一被重建就清零 →
  兄弟卡片的「生成中…」集体消失并退回 pending(标记已消费不会重跑)。这是历史 bug 的根因。
- **票据(token)不可省**:key 只认槽位,不认「第几次任务」。同槽位可先后跑多个任务
  (取消后重绘、reconcile 后重来),旧任务迟到的回调必须凭 token 认领 ——
  否则 A 被 abort 后以非 AbortError 失败(HTTP 500/429 与 abort 撞车)会把**正在跑的 B**
  标成 error。`failGen/clearGen/setGenPhase/setQueueAhead` 全部要 token;
  落盘前还要 `isCurrentGen` 自检,别把旧任务的图写进 extra。
- **槽位消失要剪枝**:`reconcileGen` 只能由挂载着的卡片触发,而用户删 tag / swipe 到
  tag 更少的一版时槽位整个没了,记录会永久留存并被日后同 key 的新卡片误认领。
  `hydrateMessage` 调 `pruneGenSlots(…, tags.length)` 只删 `seq >= tag 数` 的越界槽位
  —— **不能连在途兄弟一起清**,那等于把本次重构修掉的 bug 换个形式复现(有单测锁定)。
- **派生态**(props 算出):`ready`(有本提示词历史)/ `stale`(仅有旧提示词结果)/ `pending`。
- 图片展示**刻意不看运行态**:失败/重绘中都继续显示上一张,避免「点重绘失败 → 图凭空消失」。
- onMounted:先 `reconcileGen`(hash 变了作废旧任务),再消费 autoGenerate 标记自动开跑;
- generate():输入就地取值存 `job`(在途时组件很可能已销毁,再读 props 不可靠)→ 定种子 →
  按 `settings.defaultBackend` 分派 → `saveImageResult` 落盘 → 清运行态 → `hydrateMessage`。
  **灯箱回调同理**:灯箱挂插件 shadow root、活得比卡片长,楼层坐标必须快照后传参
  (`removeEntry(target, at)`),不能在回调里读 props。

**并发是后端属性,不是全局设置**:
- **ComfyUI 一次性全发**:`POST /prompt` 拿到 `prompt_id` 即入**服务端**队列,轮询各查各的
  `history/{id}`,ComfyUI 自己顺序执行。客户端再加队列纯属多余。轮询期间查 `/queue` 上报
  排队位置(`onQueue`),卡片显示「排队中(前面 N 个)」而非一律「生成中」。
- **NAI 要闸门**(genQueue.ts,`settings.nai.concurrency`,默认 1):`generate-image` 是阻塞式
  POST、服务端不排队,并发压过去吃 429。
- **取消必须分流**(comfyui.ts 的 `cancelPrompt`):任务在排队 → `POST /queue {delete:[id]}`;
  正在执行 → `POST /interrupt`(带 prompt_id)。**无脑 /interrupt 会打断正在跑的别的任务**
  ——旧实现如此,并发下必现。有单测锁定这两条路径。

**卡片版面(card.css)**:卡片是**聊天内嵌**元素,不是独立面板——每多一像素都在推散正文。
故头部与底部按「一行的高度」定死:头部 `4px padding + 26px 按钮 = 34px`,底部折叠入口
`5/6px padding + 22px` 一行。**所有按钮同一条基线**:`.bbi-btn` 高 26,`.bbi-btn--icon`
必须 `width == height == 26` 且图标统一 15px —— 只写 width 不写 height 时,图标按钮会
比文字按钮矮一截,同一行里一眼看得出参差(历史 bug)。图标本身也要光学对齐:
`trash/copy/download` 的墨迹范围须接近,否则像素尺寸相同仍显大小不一。
操作分工:**头部只放「对当前这张图」的操作**(下载/删除/重绘),提示词的操作(复制)
跟着提示词放进展开区——展开区里的复制按钮**绝对定位**,并排 flex 会让它随长文本高度飘到中间。

**图片放大与长按保存(Lightbox.vue)**:ST 原生灯箱够不着——入口 `.mes_img` 只是 class,
`expandMessageMedia` 读 `chat[mesid].extra.media[data-index]` 且模块私有未导出;走官方
`extra.media` 会把图挂到 `.mes_media_wrapper`(`.mes_text` 的兄弟),脱离 tag 行内位置。故自建。
**长按保存靠三条约束**(改前务必读 Lightbox.vue 顶部注释):只监听 `click` 不拦 touch;
不加 `user-select:none`/`-webkit-touch-callout:none`;显式 `touch-action:auto` 抵消 ST 的
`body{touch-action:none}`(css/mobile-styles.css:251)。灯箱挂**插件** shadow root 并 Teleport
到 `modalHost`(需要 `--bbi-*` 变量),不能挂卡片自己的 shadow——会被 `.mes_text` 的层叠上下文裁掉。

**存储(floor/storage.ts)**,两层分离:
- 图片二进制 → ST 文件系统 `user/files/bbi_<角色名哈希>_<swipeId>_<promptHash>-<genId>.<ext>`
  (角色名经 promptHash 稳定哈希,避免中文/空格被替换成连串下划线;同角色跨聊天落同一前缀);
- 元数据 → `message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }`
  (历史时间正序,卡片翻页;`slotSeq` 隔离同楼多 tag)。
- 写回用 CAS 循环(`mutateStore`,引用比对 + `saveChat`);保存顺序:先文件后指针 / 删时先指针后文件。

**出图后端(backends/)**:
- `comfyui.ts`:两种互斥模式在 `generateComfyImage` 里分叉,汇合点是「拿到可提交 JSON」:
  - **custom**:API 格式工作流模板,支持 `%prompt% %negative_prompt% %seed% %nl% %width% %height%`
    占位符(不支持即报错);
  - **simple**(comfyTemplates.ts):选模型/LoRA + 填参数,按架构模板族组装 JSON,**无占位符**。
    模板族刻意收敛为 checkpoint 系 / Flux / Anima(Qwen 链路),新架构 = 加一条模板数据 + 一个组装分支;
    正向 = 固定正面 + (nl 优先 || tag),负面 = 固定负面 + AI 动态负面(Flux 无真实负面输入,恒空)。
  请求通道自动选择 —— **浏览器直连优先,仅网络级失败(CORS/拒连)回退 ST 服务端转发**;
  排队拿到 prompt_id 后轮询失败不重发(避免重复生图)。
  入参类型是收窄后的 `ComfyRunConn`(url + 单套预设的 mode/workflow/simple + 横竖尺寸),
  **不认整个 `ComfyUISettings`**——后端层只该知道「这一次出图用什么」,不该知道用户存了几套。
- `comfyObjectInfo.ts`:简易模式的候选列表。直连 `GET /object_info` 一次拿全(含 LoRA/CLIP);
  回退 ST 转发只有 `/api/sd/comfy/models|samplers|schedulers|vaes`(服务端摘 object_info 字段,
  **没有 loras/clips 端点**),转发通道下这两组降级为手输。session 级缓存,「刷新」强制重拉。
- `nai.ts`:协议与官方一致(浏览器直连,url 可指第三方兼容站,自动补 `/ai` 前缀);v4 系走
  `v4_prompt` 结构 + vibe 编码缓存;NAI3 直接发参考原图;质量词/负面词按模型给默认值,
  渠道页可见可覆盖(存空串 = 跟随模型官方词);正向拼装顺序为
  **画师串 → 画面 tag → 质量词**(画师串来自库,见 §7);
  `.naiv4vibe` 导入导出与官方互通。
  **NAI V5(`nai-diffusion-5-*`)是另一条协议分支**:`isNai5`/`naiSupportsVibes`/`naiSamplers` 三件套
  判定——`params_version: 4`、采样器限子集(列表随模型过滤,面板同步)、`v4_prompt` 结构里
  `char_captions` 填来自协议的 characters(每角色一条,库数量 tag `1girl→girl` 降级、
  tag+中文 nl 拼一条 caption,负面侧给空 caption 占位)、varietyBoost 无效。
  **Vibe 对 V5 同样可用**:`vibeModelKey` 已含 v5full/v5curated 键,V5 走与 v4 系相同的编码
  缓存分支(`reference_image_multiple_cached` 无条件初始化);仅**非 NAI 家族模型**才不支持。
  正向串 V5 且带 nl 时拼成 `tags. nl`(句点分隔)。
- `chatu8Vibe.ts`:只读智绘姬的 extension_settings + IndexedDB,逐条导入 vibe(内容指纹去重、读取超时、迁移进度)。
  另有三件画师串预设函数(collectChatu8ArtistRefs / detectChatu8Artists / importArtistsFromChatu8):
  读 `yushe` 表 + `yusheid_novelai` 当前选中,positive 两段(fixedPrompt/fixedPrompt_end)按原序
  拼成一条画师串,按 (名字, 内容) 去重,active 预设映射到目标 id 由调用方决定是否选中;纯函数不落盘,
  UI 在 NaiPanel:对当前库实时跑 importArtistsFromChatu8 算「还剩 N 个新预设」,N>0 才显示
  文字按钮行(导完自动消失),点击进预览弹窗。
- `vibeStore.ts`:Vibe 原图/编码正文与缩略图分文件存 ST `user/files`，文件存储不可用时回退本机 IndexedDB。
  `extensionSettings['baibai_image']` 只留路径、模型键、指纹等小型索引，禁止再放 Base64。

## 7. 状态与持久化

- **settings(全局,跨设备)**:`state/settings.ts`。import 阶段以默认值建 reactive;
  ST 就绪后 `hydrateSettings()` 从 `extension_settings['baibai_image']` 载入
  (**normalize 逐字段容错 + 存量迁移**,如 resolution→横竖两格、webui 隐藏迁移);
  `ready` 守门标志防默认值覆盖服务器设置;deep watch → 防抖 `saveSettingsDebounced()`。
  订阅者用 `onSettingsReady(cb)` 等 hydrate 完成(如 ui.ts 回灌主题)。
- **ComfyUI 工作流库**:`settings.comfyui.workflows`(`ComfyWorkflowPreset[]`)+ `activeWorkflowId`。
  - 一条预设 = 名字 + `mode`(custom/simple 互斥)+ 工作流 JSON + `simple` 参数 + `naturalLanguage` + 横竖尺寸。
    这些跟着工作流走而非留在渠道级,因为它们是**底模的属性**(Illustrious 要短 tag + 832×1216,
    Flux 要自然语言 + 1024 方图);留在渠道级的话每次切工作流还得手改两处。
    `url` 反过来仍是渠道级(一台服务器跑所有工作流)。
    两模式的字段都常驻(切模式不丢另一边的配置),只是出图时只生效一边;
    存量预设没有 mode/simple 字段,normalize 补 `custom` + 简易默认值。
  - **不变式:`workflows` 恒非空**。`comfyDefaults()` 出生即带一条空预设(只用一套的人感觉不到「库」的存在),
    `normalizeComfyUI()` 收尾再兜一次;`activeWorkflowId` 悬空时回落第一条。
    消费方一律走 `activeComfyPreset()` / `effectiveComfyConn()`,不直接摸数组,故无需到处判空。
  - **存量迁移**:老配置的平铺 `workflow` / `naturalLanguage` 加渠道级横竖尺寸,由 `foldLegacyWorkflow()`
    原样折成第一条「默认工作流」(口径同 `foldLegacyNegative` / `migrateSize`:用户特意设过的值绝不被默认值顶掉);
    `workflow` 为空串也照样建这一条。靠字段有无判断,无 schemaVersion。
  - 工作流 JSON 随设置整体进 `settings.json`(单套数 KB–数十 KB)。刻意**没有**像 Vibe 那样搬去 `user/files`:
    量级差两个数量级。若日后设置保存变慢,这里是第一嫌疑人。
- **NAI 画师串库**:`settings.nai.artistPresets`(`NaiArtistPreset[]`)+ `activeArtistId`。
  一条 = 名字 + 一段拼在正向提示词**最前面**的画风 tag(`backends/nai.ts` 的
  `fullPositivePrompt`,顺序:画师串 → 画面 tag → 质量词;放最前是因为它定整幅画的基调,
  NAI 对靠前 tag 权重更高)。
  - **不按模型分表**(与质量词/负面词相反):官方质量词是**模型的属性**,切模型必须跟着换;
    画师串是**用户自己的配方**,跨模型复用才是常态,故做成可增删的库而非 `Record<model, …>`。
  - **与工作流库刻意相反的三处**:①`artistPresets` **允许为空**(工作流恒非空);
    ②`naiDefaults()` **不播种**任何一条(工作流出生即带一条);③`activeArtistId` 悬空时
    `normalizeNai` **清成空串**而非回落 `[0]`。根因是必需品与可选项的差别:不给工作流就
    出不了图,不给画师串只是不加画风;回落 `[0]` 会在用户删掉当前条目后**静默套上一套
    他没选过的画风**,而下拉显示的正是那一条(看起来就是自己设的),几乎无法排查。
    有单测锁定这条对照(`settings.naiArtistMigration.test.ts`)。
  - 空串是「不使用」的哨兵。preset id 恒为 `art_*` 形状(normalize 保证非空),故空串不会
    与任何 id 相撞,无需像 `vibeGroups` 的 `g:` 那样装箱(那里组名由用户输入、会撞名)。
    清成空串也让 `activeArtistId ∈ {'', 库中已有 id}` 成为不变式,面板无需再判悬空。
  - 消费方两条路:面板走 `activeNaiArtist()`(读全局 settings,返回 `NaiArtistPreset | null`,
    刻意只读——在 computed 里被调用);拼装走 `backends/nai.ts` 的 `naiArtistPrompt(nai)`
    (纯函数、吃 NaiSettings,可单测)。**刻意不共用一份**:settings.ts 已 import nai.ts 的
    `naiDefaultUndesired`,反向加值依赖会成运行时环。
  - ⚠ `fullPositivePrompt` 在 `buildNaiParameters`(v4_prompt 来源)与 `generateNaiImage`
    的顶层 `input` 处**各调一次**,两处必须同源。拼装改动一律留在函数内部——在某个调用点
    单独加料会让 NAI3(读 input)与 NAI4/4.5(读 v4_prompt)拿到不同提示词,且只在 NAI3
    上暴露(现有测试全是 4.5 模型,一个都不会红)。有同源断言锁定。
  - **存量迁移**:纯加法,无老字段可折。老配置 hydrate 后得空库 + 空 id,正向提示词输出
    与上线前逐字节一致。
- **Vibe 大文件**:
  - `extensionSettings['baibai_image'].nai.vibes`:仅存 `NaiVibe` 小型索引，不存原图、缩略图 dataURL 或编码正文;
  - `user/files/bbi-vibe-*.json`:原图与各模型编码正文;
  - `user/files/bbi-vibe-thumb-*`:列表缩略图;
  - IndexedDB `baibai_image_vibes`:ST 文件写入失败时的本机回退，不跨设备同步。
- **旧版 Vibe 自动修复**:`hydrateSettings()` 在 normalize 前直接扫描旧条目，按顺序逐条落盘;
  每条成功后立即原地替换并释放该条 Base64，不等整库完成。全部成功后只保存一次轻量设置。
  首次升级可能需要等待搬迁，刷新后恢复正常;若某条文件与 IndexedDB 都写失败，则保留原条目并报错，
  已成功条目不会退回大对象，下次刷新继续重试。
- **智绘姬迁移**:`chatu8Vibe.ts` 顺序读取并立即调用 `vibeStore.ts` 落盘，不在内存或设置中积累整库大对象;
  导入项默认不启用，避免生成时一次读取全部 Vibe 正文。
- **Vibe 强度唯一口径**:一律走 `vibeStore.ts` 的 `clampVibeStrength`(夹 0–1,认不出数回落
  默认 0.6)。曾有四份各自为政的实现,其中三份写作 `Number(v)`——`Number(null)`/
  `Number('')` 都是 0,「字段缺失」被静默判成「强度 0」,vibe 挂了却没效果,极难排查。
  只认真数字和可解析字符串;面板数字框 step="any" 自由填值,夹取后回写 input
  (防「填 5 被夹到 1、框里却留着 5」的骗人显示)。
- **Vibe 分组**:`NaiVibe.group` 是扁平字符串(空串 = 未分组),无独立 groups 数组——组只是
  「一起启用/一起折叠」的标签,没有自身属性,改名/删组都是对成员 group 字段的批量赋值,
  不会产生悬空引用。`backends/vibeGroups.ts` 纯逻辑:组名一律 `g:` 前缀装箱(防与
  「未分组/新建」哨兵撞名)、`groupVibes` 归拢 + 搜索、`isGroupActive` 启用集合判定
  (等于组内全部成员才生效,搜索期间仍按全量成员算)。出图只看每条 enabled,
  组的批量动作本质是对成员 enabled 的批量赋值,不引入第二套真相。
  智绘姬迁移时若旧名带「组名 · 原名」前缀(`planPrefixGroups`),还原成分组并去掉前缀。
- **副 API 渠道(跨插件共享)**:真身存 `extensionSettings['baibai_api_channels']`(带 revision),
  本插件设置里只是镜像;写入后广播 `st-baibai-api-channels:changed`,他端监听重读。
  与柏宝书共用,任一端增删改实时同步。
- **排除设置(跨插件共享)**:真身存 `extensionSettings['baibai_exclude_settings']`(带 revision),
  镜像在 `settings.excludes`(四张名单:excludedChars / excludedWorldNames /
  excludedWorldInfoPatterns / customStripTags);协议与渠道同构(指纹防回环 + revision 取 max),
  事件 `st-baibai-exclude-settings:changed`。与柏宝书共用同一份名单、同一套匹配口径:
  排除角色 → 自动 tag 全流程停用(含楼层按钮隐藏);整本/条目名排除 → 副 API 世界书过滤
  (autoTag/excludes.ts);清洗标签 → 扫描/正文清洗整块删除(autoTag/clean.ts)。
  共享存储创建时播种默认条目名规则 `\[mvu[\s\S]*?\]`(只发一次,删了不补回)。
- **ui(本机 + 同步)**:窗口开关/当前页(activePage 存 localStorage)是纯本机态;
  主题/导航/悬浮球属真设置,写入 `settings.ui` 走跨设备同步。
- **charTags(三层真源:全局库 + 本聊天手动基线 + AI 楼层增量)**:
  - **全局库**:存 `extensionSettings['baibai_image_char_global']`(globalCharTags.ts,
    协议同共享渠道:revision + 指纹 + 广播事件),跨聊天/跨设备。定位是**冻结模板**:
    只由用户手动增删改或「提升为全局」写入,不记 history;AI 的 changes 对锁定名
    (全局独有、本聊天无同名条目的角色)一律丢弃——重放(applyCharTagOps)与
    @替换(applyPositionedCharRefs)双侧拦截,runner 写楼层增量前也先滤一遍;
    库文本里锁定条目带 [locked] 标记,提示词声明其不可变。本聊天手动建同名条目
    即覆盖全局并解锁(「复制到本聊天」按钮走的就是这条);「提升为全局」把当前生效值
    快照进全局后删本聊天副本、清同名楼层 ops,由全局接管。
  - **本聊天手动基线**:存 `chatMetadata['baibai_image_char_tags']`,手动编辑/回滚/旧版快照落这里,
    不随楼层删除。
  - **AI 楼层增量**:自动建档与 changes 写进目标消息 `extra['bbiCharChanges']`
    (CharTagFloorDelta: v/swipe/ops;op 分 new/set 两种),与正文同一 CAS 写回成功才落盘,
    楼层/swipe 删除时自然失效(增量带 swipe 匹配)。
  - `charTagLib` 只是响应式派生缓存:合并种子(本聊天优先,全局补同名空缺,
    mergeCharTagSeed)+ 按楼层物理顺序重放增量(deriveCharTags,带锁定名过滤);
    `charTagsBeforeFloor(floor)` 取楼层时刻快照;MESSAGE_DELETED/MESSAGE_SWIPED 后重算。
  - 手动编辑/删除 = 用户接管:detachFromExistingFloors 清掉该角色在旧楼层里的同名操作
    (压进手动基线),之后新楼层仍可继续被 AI 变更。
  - 建档与后续维护都归主请求(changes 的 field="new"/字段更新),与选图同属一次推理;
    外貌按字段(sex/hair/eyes/skin/body/extra/outfit)记录,拼接顺序即最终 tag;
    旧整串以 raw 兼容。建档必须带 hair 与 eyes(二次元身份锚点),缺任一项该条丢弃。
    柏宝书的中文外貌随角色参考块发给主请求作依据;角色管理页另有「按柏宝书最新外貌
    生成」按钮(generateCharTags),那是用户主动点的一次性转换,不在自动流程里。
  - AI 引用走**直接照抄**(v0.1.2 起):提示词要求把库中字段值一字不改写进 tag/nl(库里写
    long black hair 就写 long black hair),不用 @角色名 占位符。撤回原因:同一角色被引用
    多次时逐次展开,一张图里出现多份完整外貌 + 多个 1boy,模型据此画出重叠躯干;且
    「40 tag 以内」的预算无法执行(AI 数 @小雪 是 1 个,展开成 6 个);库脏数据也会被
    无条件放大。库文本本就在同一上下文里,照抄可见文本比凭记忆复述可靠。
    applyCharRefs 系函数保留为兜底:模型偶发写出 @名字 时仍会被替换,不至于把字面量
    送进生图。同一角色的固定外貌一张图里只写一遍,再次提到用简短指代承接。
    页面提供历史查看与逐条回滚(建档记录回滚 = 删条目)。

## 8. 贯穿全项目的约定

- **降级优先**:任何宿主能力取不到(柏宝书/EJS/checkWorldInfo/渠道)→ 返回 null/空串,不阻断主流程;
- **幂等**:所有 bind*/inject*/ensure* 可重复调用;水合/按钮注入都靠内部标志或 DOM 检查;
- **CAS 写回**:改正文(messageEdit)、改 extra(storage)都先比对基准再落盘,失败放弃;
- **abort 贯通**:AbortController 从 runner 一路传到 fetch/轮询(comfyui 的 abortableDelay);
- **纯函数可测**:解析/协议/参数构造均为纯函数,配 `*.test.ts`(vitest,与被测文件同目录)。
  改协议/后端参数时跑 `pnpm test` 保底;
- **渠道二选一**:`getTagGenChannel()` 有指派 → 副 API(服务端代理);否则跟随主 API(generateRaw)。
- **随机段一律走 `randomUuid()`**(src/randomUuid.ts):ST 常在非安全上下文(http)下运行,
  那里 `crypto.randomUUID` 直接抛错;vibe 缓存键/文件名随机段只是防撞,不需要密码学强度。

## 9. 任务定位索引(改需求先查这里)

| 想改什么 | 去哪个文件 |
|---|---|
| 启动流程 / 新子系统挂载 | src/index.ts |
| 设置项(新增字段/默认值/迁移) | src/state/settings.ts(类型 + defaults + normalize 三处) |
| 设置窗口 UI | src/pages/settings/index.vue |
| 提示词内置默认(破限/规范/思维链/预填充) | src/state/settings.ts 的 `DEFAULT_*` 常量 |
| 自动 tag 触发条件 / 去重 / 重试 | src/autoTag/runner.ts + generationGate.ts(生成门配对) |
| 发给 LLM 的消息组装(顺序/内容) | src/autoTag/prompt.ts(V5 走 DEFAULT_NAI_V5_SPEC:Base+Character 双提示) |
| LLM 输出协议(JSON 形状/位置 ID/tag 格式) | src/autoTag/protocol.ts |
| 世界书/角色卡/persona 装配 | src/autoTag/context.ts |
| 柏宝书状态读取 | src/autoTag/bookMemory.ts |
| 角色库 v3(基线+楼层增量/changes ops/@占位符兜底/历史回滚) | src/autoTag/charAnchors.ts + src/state/charTags.ts + src/autoTag/runner.ts |
| Vibe 分组 / 搜索 / 启用集合判定 | src/backends/vibeGroups.ts(纯逻辑)+ NaiPanel.vue(交互) |
| 副 API 请求(代理/SSE/超时/测试) | src/api/client.ts |
| 跟随主 API | src/api/client.ts 的 requestViaMainApi |
| ComfyUI 工作流 / 出图 / 通道回退 | src/backends/comfyui.ts |
| ComfyUI 简易模式(模板组装/校验) | src/backends/comfyTemplates.ts(UI 在 ComfyUIPanel.vue) |
| ComfyUI 模型/LoRA 列表拉取 | src/backends/comfyObjectInfo.ts |
| ComfyUI 工作流库(多套保存/切换) | src/state/settings.ts 的 `ComfyWorkflowPreset` + `activeComfyPreset` / `effectiveComfyConn`(UI 在 ComfyUIPanel.vue) |
| 工作流 AI 自动配置(节点定位) | src/backends/comfyWorkflowAssistant.ts(+ 面板按钮在 ComfyUIPanel.vue) |
| NAI 参数 / vibe / .naiv4vibe / 智绘姬画师串导入 | src/backends/nai.ts + vibeStore.ts + chatu8Vibe.ts(NaiPanel 提供 UI) |
| NAI 画师串库(多套保存/切换/拼在最前) | src/state/settings.ts 的 `NaiArtistPreset` + `activeNaiArtist`(拼装在 backends/nai.ts 的 `naiArtistPrompt` / `fullPositivePrompt`,UI 在 NaiPanel.vue) |
| 画幅方向 / 尺寸解析 | src/backends/size.ts(刻意不依赖 settings) |
| 楼层卡片显示 / 水合 / 状态机 | src/floor/hydrate.ts + Card.vue |
| 卡片「生成中」状态 / 取消 / 并发 | src/floor/genState.ts(运行态)+ genQueue.ts(NAI 闸门) |
| 图片放大 / 长按保存 / 保存删除按钮 | src/floor/Lightbox.vue + lightbox.ts(另存走 download.ts) |
| 卡片版面 / 按钮尺寸基线 / 卡片主题 | src/floor/card.css + cardStyles.ts(令牌来自 styles/theme.css) |
| 结果存储 / 文件命名 / CAS | src/floor/storage.ts + upload.ts |
| 显示/提示词两侧的正则 | src/st/imageTagRegex.ts |
| 楼层按钮 / 顶栏按钮 / 魔杖入口 | src/floor/actionButton.ts / src/topbar.ts / src/menu.ts |
| 正文写回(含竞态) | src/st/messageEdit.ts |
| 请求历史(LLM/生图,内存不持久化) | src/state/history.ts(store)+ src/pages/history/index.vue(页面)+ src/api/client.ts 埋点 |
| 复制到剪贴板 | src/st/clipboard.ts 的 copyText |
| 主窗口 UI(遮罩/导航/动画/抽屉) | src/App.vue + state/ui.ts + components/ |
| 主题 | src/styles/theme.css + state/ui.ts 的 THEMES |
| 图标 | src/components/Icon.vue(新增图标 + PATHS) |
| 新增页面 | src/pages/<id>/index.vue + pages/registry.ts 注册 + Icon.vue 加图标 |
| 版本号 | package.json(build 自动同步到 manifest.json;更新对比源 = 远端 GitHub manifest.json 的 version) |
| 更新检测 / 自动更新 | src/update.ts(红点/按钮在 NavBar.vue + settings/index.vue;仅 `isNewer` 有单测) |

## 10. 测试与构建

```bash
pnpm test        # vitest 单测(与源码同目录 *.test.ts)
pnpm typecheck   # vue-tsc
pnpm build       # 产物 dist/(build 前自动 sync manifest 版本)
```

单测重点覆盖:autoTag 的协议解析/提示词组装(快照)、backends 的参数构造与工作流渲染、
floor 的存储结构/自动生成标记/运行态与闸门(genState/genQueue 的 token 认领、剪枝、并发)、
size 归一化。UI 层(Vue 组件)无测试。
