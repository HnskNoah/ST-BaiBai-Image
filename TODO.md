# 待办(已定稿、未排期)

这里只放**已经讨论定稿、但决定先不做**的功能。每条要能直接照着实现:记清「判定与落点、数据结构、边界与既定取舍」,而不是一句标题。
已完成项不进这里(现状见 `architecture.md`,历史见 git log);还只是设想的草案放 `DESIGN.md`。

---

## 分级切模型:命中 rating:general 时自动改用同代 Curated(NAI 渠道)

**需求**:NAI 渠道下,当画面 tag 含 `rating:general` 时,本次生成改用**同代的 Curated 模型**
(4.5f→4.5c、5f→5c)。官方标签本身就是「Full(无过滤)」/「Curated(有内容过滤)」,故这是
「SFW 内容用有过滤的模型」策略。

**判定与落点(已论证,勿改回「写回正文前」)**
- 判定时机:**出图时**(`src/generate.ts` 的 NAI 分支),永远读「此刻的渠道设置 + 此刻的正文 tag」。
  若放到 runner 的写回前,结论必须持久化(写进正文的 `<model>` 章或运行时态),于是要回答
  「用户事后改了模型设置算谁的 / 自动出图延迟期间章是否过期 / 手动改 tag 后谁清章」——任何一条都会
  引入**第二套真相**(正文里的章 vs 渠道设置),已否决。
- 覆写方式:对 `effectiveNai()` 的返回值**覆写 `model`** 再交给 `generateNaiImage` ⇒ `backends/nai.ts`
  一行不改;`params_version` / sampler 白名单 / characters 支持判断 / `vibeModelKey` / `skip_cfg`
  全由这一个值派生,结构上不可能出现「载荷用 curated、派生按 full 算」的混合态。
- **必须显式限定 `status.backend === 'nai'`**:`latentAsNai()` 的视图会 spread `settings.nai`,
  不限定就会让 latent 生成误读 NAI 的开关、并改掉 latent 的协议 model 字段。
- 配对:同代机械配对 `-full` → `-curated`;当前已是 Curated ⇒ no-op。

**触发语义**
- 只在**画面 tag 区**(`GenerateInput.prompt`)上判定;不看 nl / 画师串 / 质量词,**不看 `negative`**。
- 与角色屏蔽栏、`autoTag/tagRules.ts` 同一套分段口径:**逗号分段 + trim + 大小写不敏感 + 整段精确**。
- 逐张 / 逐槽位独立判定 ⇒ 同一楼可能一张 Curated、一张 Full(这是「按内容切」的自然结果)。
- 触发词**可编辑列表**,默认 `['rating:general']`(想含 `rating:sensitive` 自己加)。
- 兜底:tag 里同时出现 `rating:explicit` / `rating:questionable` ⇒ **不切** + `console.warn`
  —— Curated 有内容过滤,避免误判把用户本来要画的内容过滤掉。

**开关与文案**
- 渠道级开关放 NAI 面板「默认参数」区**模型选择器旁**(它影响的就是模型),**默认关**:它会静默改变
  出图结果与 Vibe 行为,该由用户显式打开。
- 文案里必须写明:**Vibe 编码按模型分开存**(`vibeModelKey`:v5full / v5curated / v4-5full / v4-5curated),
  切到 Curated 后原来为 Full 编的 vibe **没有编码会被跳过**,要用 Curated 出图请在 vibe 库为它再编码一次。
- Vibe 冲突处理:**照切** + 依赖现有 `toastr` 警告(「vibe「X」因缺当前模型编码被跳过」,不静默);
  **不做**跨代复用编码(编码与模型绑定,复用是错的)。

**可观测**
- 切换时 `console.info('[柏宝绘] 命中 rating:general → 本次使用 nai-diffusion-5-curated')`。
- `getBackendStatus().model` **不动**:它反映渠道设置,不是「本次运行用哪个」。

**图库可见性(本轮定的档)**
- `GenerateOutput` 加 `model?: string`(本次实际使用的模型)→ 楼层存图与公开接口存图都拿得到。
- `BbiImageSidecar` 升 **`v: 2`** 加 `model?: string`(`v` 字段当初就是为「日后加 backend/model」留的);
  写入点是 `floor/storage.ts` 的 `uploadImageWithSidecar`(全仓唯一物理存图路径),两个调用点各传一次。
- 图库展示一行:`NAI_MODELS` 的 label 截到括号前(如 `NAI 5 Curated`),取不到就用原串。
- 老 `v: 1` 侧写无此字段 ⇒ 不显示、零迁移、零报错。
- 公开接口 `GenerateResult.model` 与 `GenerateOutput.model` 同源,**同批更新 `PUBLIC_API.md`**
  (结构只增不改不删,合规)。
- ComfyUI / Latent 本期不填(model 概念对前者是工作流/底模,对后者是站点固定底层模型)。

**合规项**
- 新设置字段(如 `sfwCuratedSwitch: boolean` + `sfwCuratedTags: string[]`)落在 `settings.nai` 里 ⇒
  **必须进 `normalizeNai` 的逐字段重建表** + 配「改过的值 hydrate 后仍在」的用例(见 `architecture.md` §8:
  本地字段在上游逐字段重建的表里没位置,就会载入即剥、首次写回永久丢)。
- 测试:纯函数(`pickGenerationModel`)单测 + 配对/兜底/大小写/整段精确 + normalize 保留用例。

**与「联动加词」的关系**
联动加词发生在**写回正文前**,换模型在**出图时**读正文 —— 若某条加词规则注入了 `rating:general`,
换模型判定会自然看到它,不需要额外协调(写进注释,免得下一个人去找「顺序在哪定的」)。

---

## 额外指定世界书(每聊天一份名单:把这些书也纳入 tag 生成那轮扫描)

**需求**:除 ST 当前挂载的世界书之外,再额外指定**某本或多本**参与 tag 生成那次请求的扫描;
名单**绑定聊天**(与角色档案"本聊天层"同性质),换聊天各自一份。

**动机(用户原话的用例)**:像「人物形象 / 服装描述」这种**只对选画面有用**的设定书,希望
**tag 生成能读到、主对话读不到** —— 在 ST 那边挂书会把这本设定塞进主对话上下文(占 token、
影响 RP 走向),本功能正是为了避开这点:这本书不进主对话、不影响剧情,只在 tag 生成那一刻读。
(因此它与"在 ST 里给聊天挂一本书"是互补而非重复:那本主对话也读,这本只有 tag 生成读。)

**语义(定案,别扩别缩)**
- 指定的书**像普通世界书一样参与激活**:蓝灯(constant)恒激活、绿灯按扫描文本命中关键词 ——
  **不是**"整本强制全带"(那是另一种语义,已否决)。
- 两条必须写进 UI 文案的后果:
  1. **已经挂在当前聊天 / 角色卡上的书,本来就会被扫到** —— 本功能真正新增的是**没挂载的书**
     (或你希望脱离 ST 那份挂载决定、由本插件独立控制的书);
  2. 扫描文本仍是现有窗口(`contextMessages` 决定的最近 N 楼 + 目标楼,来源 `recentFloors`),
     **不会**因为指定了书就变宽 —— 绿灯条目能否命中,取决于关键词是否出现在那个窗口里。
     「额外书用更宽的扫描文本」是另一个决定,不要顺手实现。
- 与排除名单:**排除永远最后说话**(合并去重 → 排序 → 整本排除 → 条目名规则 → 渲染),选中集仍可细挑。
- 名单为空 = 行为与今天完全一致(零变化)。

**实现路线(已在 TauriTavern 源码里核实,不再是"待调研")**
- ❌ **没有 per-call 附加书入口**:`checkWorldInfo(chat, maxContext, isDryRun, globalScanData)` 的第 4 参是
  **额外扫描文本**(personaDescription / characterDescription / characterPersonality / scenario /
  creatorNotes / trigger),不是书;书只来自四个来源 —— 全局选中 `selected_world_info`、角色的世界
  (含 `world_info.charLore[].extraBooks`)、聊天级 `chat_metadata['world_info']`、人设书。
- ❌ **不能借 ST 的扫描**:主对话与我们这次请求**共用同一个 `checkWorldInfo`**。临时改 `selected_world_info`
  或往 `WORLDINFO_ENTRIES_LOADED` 载荷数组里 push(它是**借引用、未文档化**,仓里没有消费者),
  都会**同时影响主对话** —— 正好违背本功能的初衷。
- ❌ **不用 `WORLDINFO_FORCE_ACTIVATE`**(vectors 扩展在用、机制正规):它是"**无条件**激活",
  与"蓝绿灯照常"语义不符;而且同样只能靠"调用窗口"来隔离,并发时会漏进主对话。
- ✅ **采用的路线:自己读书 + 自己判定 + 自己拼进我们的 system 消息** —— **完全不惊动 ST**,天然只影响 tag 生成。
  - 读书:`getContext().loadWorldInfo(name)`(**已暴露**,见 `script.js` 的 getContext;底层
    `POST /api/worldinfo/get` `{name}` + `worldInfoCache`,带 in-flight 去重)。读不到 → 跳过 + `console.warn`。
  - 判定(口径与 ST 同源):`disable === true` 跳过;`constant === true` 直接进;否则用 `key`(主键)匹配扫描文本 ——
    大小写/整词读 ST **导出的**全局设置(`world_info_case_sensitive` / `world_info_match_whole_words`,
    条目可用 `caseSensitive` / `matchWholeWords` 覆盖),`/正则/` 形式的键走正则,整词 + 单键用 ST 同款边界式
    `(?:^|\W)(key)(?:$|\W)`;扫描窗口取 `entry.scanDepth ?? world_info_depth` 条**最新**消息(与 ST 同口径)。
  - **登记在案、不实现的漂移面**(UI 文案说明):`keysecondary`/`selective`/`selectiveLogic`、
    `probability`/`useProbability`、递归类(`excludeRecursion`/`delayUntilRecursion`/`preventRecursion`)、
    分组权重、`vectorized`、`matchPersonaDescription` 等附加匹配源。命中这些字段的条目按主键规则处理并留一条
    `console.debug` 记录(不静默假装支持)。
  - 渲染与合并沿用现有链:`renderWorldInfoContent`(宏 → EJS)→ 与 ST 激活结果按 `world#uid` 去重 →
    `sortWorldInfoEntriesLikeST` → 排除名单 → 拼进同一个「世界设定」system 消息。
- ✅ **前置缺陷已修(与额外书功能无关,先落地了)**:我们曾把扫描文本按**楼号升序**传给
  `checkWorldInfo` / `getWorldInfoPrompt`,而 ST 期望**最新在前**(`script.js` 组装 `chatForWI` 时
  `.reverse()`;`WorldInfoBuffer.#initDepthBuffer` 直接按 index 当深度)。后果:绿灯条目只在窗口
  **最早**的那几楼里匹配(默认 Scan Depth=2 ⇒ 几乎全灭),蓝灯不受影响。
  修法:`buildScanText` 末端 `.reverse()`(两处调用点共用),`autoTag/context.test.ts` 三条用例锁死
  (含"去掉 reverse 即失败"的回归价值),顺序契约写进 architecture.md §5。
- 顺带:正因为不经过 ST 挂载,ST 侧换书 / 改挂载都不影响 tag 生成读什么;若同一本在 ST 也挂着,
  两边都读 → 合并时按 `world#uid` 去重,不会重复出现。

**存储(每聊天)**
- 新 chatMetadata 键(如 `baibai_image_world_extra`),形态照 `state/charTags.ts` 的约定:
  版本化对象 `{ version: 1, names: string[] }` + `context.saveMetadataDebounced()`;
  `CHAT_CHANGED` 时重载(照抄 `charTags.ts` 的 `context.eventSource.on(CHAT_CHANGED, hydrateXxx)`)。
- 名字清洗复用 `normalizeBlockedFragments`(trim / 去空 / 剥尖括号 / 按小写去重)。
- **不进 settings、也不进与柏宝书共享的排除名单存储**(那是全局的,本名单是聊天的)。

**落点**
- 装配:`autoTag/context.ts` 的 `fetchWorldInfo`——在 `checkWorldInfo` 之后把"额外书"的激活结果
  **并进同一个条目集合**(按 `world#uid` 去重),再走现有 `sortWorldInfoEntriesLikeST` → 排除 → 渲染;
  渲染链(宏/EJS)、去重、排序全部复用,不新增第二条渲染路径。
- UI:设置页「排除世界书内容」区旁新增一行入口,复用同一个「搜索 + 勾选」弹窗(**抽成共用组件**,
  与排除世界书那个弹窗同一份实现;书单来源同样是 `getWorldInfoNames()` + 旧版 ST 的 DOM 回退)。
  标签写明**「仅当前聊天」**(措辞与角色页的"全局层 / 本聊天层"对齐),
  说明文案写明卖点:**只让 tag 生成读这本,主对话不受影响**。

**测试**
- 合并去重:同一本书既被 ST 激活又被"额外指定"命中 → 只出现一次(按 `world#uid`)。
- 排除优先:额外书里的条目命中整本排除 / 条目名规则 → 被剔除。
- 读书失败:走兜底 / 跳过 + warn,主流程照常(不抛)。
- 聊天隔离:切聊天后名单重载,前一个聊天的名单不生效;名单为空时行为与现状逐字节一致。
- normalize:脏数据(非数组 / 重复 / 带尖括号)清洗;版本化 store 往返。


