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
│   └── iconFallback.ts# 注入按钮的字体图标兜底(防美化主题清空图标)
├── state/             # 全局状态与持久化
│   ├── settings.ts    # ★ 设置模型 + hydrate/persist/迁移 + 跨插件共享渠道存储
│   ├── ui.ts          # 窗口开关/主题/导航/悬浮球;activePage 存 localStorage
│   └── charTags.ts    # 角色固定外貌库(字段式,仅当前聊天,存 chatMetadata;含变更历史)
├── api/
│   └── client.ts      # LLM 请求:副 API 走 ST 服务端代理 / 跟随主 API 走 generateRaw
├── autoTag/           # ★ 链路 A:自动生 tag(独立 LLM 请求 → 协议校验 → 注入正文)
│   ├── runner.ts      # 事件监听、去重、重试、编排(入口)
│   ├── prompt.ts      # 组装消息:破限/角色/人设/世界书/规范/协议/思维链/预填充
│   ├── protocol.ts    # 段尾位置 ID、JSON 严格解析校验、tag 注入格式
│   ├── clean.ts       # 历史/目标正文清洗(共享排除标签;历史保留 bbi_image)
│   ├── context.ts     # 世界书激活(条目级渲染:展宏+EJS)、角色卡、user 人设
│   ├── bookMemory.ts  # 读「柏宝书」全局 API,解析成角色参考块
│   └── charAnchors.ts # 角色库:柏宝书建档/库文本注入 → @占位符替换(AI 报名不抄外貌)
├── backends/          # 出图后端(链路 B 的生成端)+ 共享尺寸工具
│   ├── comfyui.ts     # ComfyUI:工作流模板 %占位符% 渲染、浏览器直连/ST 转发自动回退
│   ├── nai.ts         # NovelAI:参数构造、vibe 编码/叠加、.naiv4vibe 导入导出
│   ├── chatu8Vibe.ts  # 从智绘姬(st-chatu8)只读导入 vibe
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
│   ├── characters/index.vue   # 「角色管理」页:固定外貌 tag 库 CRUD
│   └── settings/index.vue     # 「设置」页:渠道管理/自动 tag/提示词编辑/界面偏好(最大页)
├── components/       # 通用组件:BbiSelect/BbiTextarea/Collapsible/ConfirmDialog/FloatingOrb/Icon/ModalMask/NavBar
├── styles/           # base.css(全局基础样式)、theme.css(主题变量,data-theme 切换)
├── menu.ts           # 魔杖菜单入口注入(轮询等懒加载)
├── topbar.ts         # ST 顶栏快速打开按钮(受 ui.showTopBar 开关控制)
└── version.ts        # 版本号(__BBI_VERSION__)+ 带 ver 的资源 URL
```

## 3. 启动与挂载(读 index.ts)

1. `mount()`:在 body 建 `#bbi-app-host`(light DOM,`display:contents`),用 `INHERITED_RESET`
   内联 `!important` 钉死可继承排版属性,切断 ST 样式继承;Vue 应用整体挂进它的 **shadow root**;
   `dist/index.css` 以 `<link>` 注入 shadow root —— 样式双向隔离。
2. `$(() => ...)`:挂载应用、注入魔杖菜单入口、按开关同步顶栏按钮。
3. `hydrateWhenReady()`:轮询 `window.SillyTavern.getContext`(最多 ~20s),就绪后依次:
   `hydrateSettings()` → `bindCharTagSync()` → `ensureImageTagRegexRegistered()` →
   `bindAutoTagging()` → `bindFloorHydration()` → `bindTagActionButtons()`。
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
| `chatMetadata['baibai_image_char_tags']` | state/charTags.ts | 角色固定外貌库(仅当前聊天) |
| ST 事件 | 各 bind 处 | `CHARACTER_MESSAGE_RENDERED / USER_MESSAGE_RENDERED / MESSAGE_UPDATED / MESSAGE_SWIPED / MESSAGE_DELETED / CHAT_CHANGED` |
| `generateRaw` | api/client.ts | 跟随主 API 的一次性补全(ST 稳定 API) |
| `getWorldInfoPrompt` / 动态 import `checkWorldInfo` | autoTag/context.ts | 世界书激活(后者拿条目对象可逐条渲染;取不到自动降级前者) |
| `globalThis.EjsTemplate`(ST-Prompt-Template) | autoTag/context.ts | 世界书条目 EJS 执行(未装则降级) |
| `globalThis.STBaiBaiBook` | autoTag/bookMemory.ts | 柏宝书角色状态(apiVersion 1;不可用返回 null 降级) |
| HTTP 代理 | api/client.ts、backends/comfyui.ts、floor/upload.ts | `/api/backends/chat-completions/generate`、`/api/backends/chat-completions/status`、`/api/sd/comfy/*`、`/api/files/upload|delete` |
| 注入 DOM | menu.ts、topbar.ts、floor/actionButton.ts | 魔杖菜单 / 顶栏按钮 / 楼层按钮(不进 shadow) |

注意:三处 UI 的隔离层次不同,样式约定各不一样 ——
- 设置窗口:整个 Vue 应用挂在一个大 shadow root(`#bbi-app-host`),样式走 dist/index.css;
- 楼层卡片:每个锚点各自 attachShadow(见 §6),样式走 cardStyles.ts 的共享 CSSStyleSheet;
- 注入按钮(魔杖/顶栏/楼层按钮):纯 DOM、无 shadow,样式直接吃 ST 的。

## 5. 链路 A:自动生 tag(autoTag/)

触发:`CHARACTER_MESSAGE_RENDERED`(排除 extension/first_message/command/impersonate 等渲染类型)→ `runner.ts` 的 `runForFloor`。

```
runForFloor(floor, opts)
  1. 过滤:仅 AI 故事楼;已有 <bbi_image> 且非手动 replace 则跳过
  2. 身份去重:chatId\0floor\0swipeId\0textHash → processed Set;手动(manual)绕过
  3. 每楼一个 AbortController:同楼新任务 abort 旧任务;CHAT_CHANGED 全量取消
  4. 装配上下文(并行):
     - bookMemory.readBookMemory  → 柏宝书角色参考块(可 null)
     - charAnchors.resolveCharAnchors → 柏宝书新角色入库 → 库文本(给 AI 判断变更/引用;失败降级 null)
     - prompt.buildAutoTagMessages → 消息数组(见下)
  5. 请求:getTagGenChannel() 有指派渠道 → requestCompletion(服务端代理);
     否则 requestViaMainApi(generateRaw)
  6. 重试循环:retryCount 次(请求异常 / 解析抛错都重试;abort 不消耗;「无画面」不算失败)
  7. protocol.parseImagePlan 严格校验(JSON 结构/目标位置 ID/禁含子标签/size 宽容降级竖屏)
  8. changes 落库(先于引用:本楼变化当楼生效;建档/字段变更记历史,不询问用户)
  9. @占位符替换:applyCharRefs 把 tag/nl 里的 @角色名 换成最新库 tag(nl 优先条目自然语言句),未知占位符剥除并告警
 10. protocol.injectImageTags 按位置 ID 映射在原始物理行后插入 <bbi_image>tag<nl>…</nl><size>…</size></bbi_image>
 11. 若 autoGenerate 开:先 markForAutoGenerate 每个新槽位(见链路 B 握手)
 12. messageEdit.applyMessageText CAS 写回(正文/swipe/聊天任一变化即放弃,并撤销标记)
```

消息顺序(prompt.ts 固定):破限 system → 角色卡 system → persona system → 世界书 system →
后端规范 system(ComfyUI/NAI 内置 spec,`{{nl}}` 宏按「生成自然语言」开关展开)→ 固定协议
(输出 JSON 契约:images + changes)→ 思维链 system → user(角色参考 + 角色库 + 清洗后的最近 N 个 AI 故事楼及其间 user 楼 + 带段尾位置 ID 的目标正文)
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

**卡片状态机(Card.vue + genState.ts)**:
- **运行态**(genState.ts 的模块级 reactive Map,key 同上):`queued / generating / error`
  —— **必须放在组件外**。卡片生命周期由水合决定:任一槽位出图成功就 `hydrateMessage`,
  而它卸载**整楼**卡片;ST 重渲染楼层时锚点也会重建。运行态若存组件 ref,一被重建就清零 →
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
- 图片二进制 → ST 文件系统 `user/files/bbi_<chatId>_<swipeId>_<promptHash>-<genId>.<ext>`;
- 元数据 → `message.extra.bbiImage = { [swipeId]: { [promptHash]: BbiImageEntry[] } }`
  (历史时间正序,卡片翻页;`slotSeq` 隔离同楼多 tag)。
- 写回用 CAS 循环(`mutateStore`,引用比对 + `saveChat`);保存顺序:先文件后指针 / 删时先指针后文件。

**出图后端(backends/)**:
- `comfyui.ts`:API 格式工作流模板,支持 `%prompt% %negative_prompt% %seed% %nl% %width% %height%`
  占位符(不支持即报错);请求通道自动选择 —— **浏览器直连优先,仅网络级失败(CORS/拒连)回退 ST
  服务端转发**;排队拿到 prompt_id 后轮询失败不重发(避免重复生图)。
- `nai.ts`:协议与官方一致(浏览器直连,url 可指第三方兼容站,自动补 `/ai` 前缀);v4 系走
  `v4_prompt` 结构 + vibe 编码缓存;NAI3 直接发参考原图;质量词/负面预设按模型查内置表;
  `.naiv4vibe` 导入导出与官方互通。
- `chatu8Vibe.ts`:只读智绘姬的 extension_settings + IndexedDB,导入 vibe(内容指纹去重)。

## 7. 状态与持久化

- **settings(全局,跨设备)**:`state/settings.ts`。import 阶段以默认值建 reactive;
  ST 就绪后 `hydrateSettings()` 从 `extension_settings['baibai_image']` 载入
  (**normalize 逐字段容错 + 存量迁移**,如 resolution→横竖两格、webui 隐藏迁移);
  `ready` 守门标志防默认值覆盖服务器设置;deep watch → 防抖 `saveSettingsDebounced()`。
  订阅者用 `onSettingsReady(cb)` 等 hydrate 完成(如 ui.ts 回灌主题)。
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
- **charTags(仅当前聊天)**:存 `chatMetadata['baibai_image_char_tags']`(version 2),
  `CHAT_CHANGED` 时重载。外貌按字段(sex/hair/eyes/skin/body/extra/outfit)记录,
  拼接顺序即最终 tag;旧版整串数据以 raw 模式兼容。
  维护权归 AI:输出协议 changes 直接落库并记历史(reason + 楼层),不询问用户;
  柏宝书只负责首次建档(book 来源),此后条目归 AI 维护,柏宝书外貌再变不自动覆盖;
  手动改动同样可被 AI 继续更新。页面提供历史查看与逐条回滚(建档记录回滚 = 删条目)。
  AI 引用走 @角色名 占位符,由 applyCharRefs 在注入前机械替换,杜绝复述漂移。

## 8. 贯穿全项目的约定

- **降级优先**:任何宿主能力取不到(柏宝书/EJS/checkWorldInfo/渠道)→ 返回 null/空串,不阻断主流程;
- **幂等**:所有 bind*/inject*/ensure* 可重复调用;水合/按钮注入都靠内部标志或 DOM 检查;
- **CAS 写回**:改正文(messageEdit)、改 extra(storage)都先比对基准再落盘,失败放弃;
- **abort 贯通**:AbortController 从 runner 一路传到 fetch/轮询(comfyui 的 abortableDelay);
- **纯函数可测**:解析/协议/参数构造均为纯函数,配 `*.test.ts`(vitest,与被测文件同目录)。
  改协议/后端参数时跑 `pnpm test` 保底;
- **渠道二选一**:`getTagGenChannel()` 有指派 → 副 API(服务端代理);否则跟随主 API(generateRaw)。

## 9. 任务定位索引(改需求先查这里)

| 想改什么 | 去哪个文件 |
|---|---|
| 启动流程 / 新子系统挂载 | src/index.ts |
| 设置项(新增字段/默认值/迁移) | src/state/settings.ts(类型 + defaults + normalize 三处) |
| 设置窗口 UI | src/pages/settings/index.vue |
| 提示词内置默认(破限/规范/思维链/预填充) | src/state/settings.ts 的 `DEFAULT_*` 常量 |
| 自动 tag 触发条件 / 去重 / 重试 | src/autoTag/runner.ts |
| 发给 LLM 的消息组装(顺序/内容) | src/autoTag/prompt.ts |
| LLM 输出协议(JSON 形状/位置 ID/tag 格式) | src/autoTag/protocol.ts |
| 世界书/角色卡/persona 装配 | src/autoTag/context.ts |
| 柏宝书状态读取 | src/autoTag/bookMemory.ts |
| 角色库(建档/@占位符/changes 落库/历史回滚) | src/autoTag/charAnchors.ts + src/state/charTags.ts + src/autoTag/runner.ts |
| 副 API 请求(代理/SSE/超时/测试) | src/api/client.ts |
| 跟随主 API | src/api/client.ts 的 requestViaMainApi |
| ComfyUI 工作流 / 出图 / 通道回退 | src/backends/comfyui.ts |
| NAI 参数 / vibe / .naiv4vibe | src/backends/nai.ts(+ chatu8Vibe.ts 导入) |
| 画幅方向 / 尺寸解析 | src/backends/size.ts(刻意不依赖 settings) |
| 楼层卡片显示 / 水合 / 状态机 | src/floor/hydrate.ts + Card.vue |
| 卡片「生成中」状态 / 取消 / 并发 | src/floor/genState.ts(运行态)+ genQueue.ts(NAI 闸门) |
| 图片放大 / 长按保存 / 保存删除按钮 | src/floor/Lightbox.vue + lightbox.ts(另存走 download.ts) |
| 卡片版面 / 按钮尺寸基线 / 卡片主题 | src/floor/card.css + cardStyles.ts(令牌来自 styles/theme.css) |
| 结果存储 / 文件命名 / CAS | src/floor/storage.ts + upload.ts |
| 显示/提示词两侧的正则 | src/st/imageTagRegex.ts |
| 楼层按钮 / 顶栏按钮 / 魔杖入口 | src/floor/actionButton.ts / src/topbar.ts / src/menu.ts |
| 正文写回(含竞态) | src/st/messageEdit.ts |
| 主窗口 UI(遮罩/导航/动画/抽屉) | src/App.vue + state/ui.ts + components/ |
| 主题 | src/styles/theme.css + state/ui.ts 的 THEMES |
| 图标 | src/components/Icon.vue(新增图标 + PATHS) |
| 新增页面 | src/pages/<id>/index.vue + pages/registry.ts 注册 + Icon.vue 加图标 |
| 版本号 | package.json(build 自动同步到 manifest.json) |

## 10. 测试与构建

```bash
pnpm test        # vitest 单测(与源码同目录 *.test.ts)
pnpm typecheck   # vue-tsc
pnpm build       # 产物 dist/(build 前自动 sync manifest 版本)
```

单测重点覆盖:autoTag 的协议解析/提示词组装(快照)、backends 的参数构造与工作流渲染、
floor 的存储结构/自动生成标记/运行态与闸门(genState/genQueue 的 token 认领、剪枝、并发)、
size 归一化。UI 层(Vue 组件)无测试。
