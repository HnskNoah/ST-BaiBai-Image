# 柏宝绘 Vibe 两个用户反馈问题 — 排查与代码定位文档

> 给接手修复的人看。两个问题均来自用户反馈,仅涉及 NAI 后端的 Vibe 功能。
> 涉及两个插件(都在本机,路径见下),改完柏宝绘侧需要 `pnpm build` 重新构建 `dist/index.js`。

- **柏宝绘(本仓库)**:`D:/1/SillyTavern/public/scripts/extensions/third-party/ST-BaiBai-Image`
- **智绘姬(st-chatu8,只读参考)**:`D:/1/SillyTavern/public/scripts/extensions/third-party/st-chatu8`(其数据只被柏宝绘只读导入,禁止写)

---

## 问题 1:从智绘姬迁移的 Vibe,很多没有按组迁移,需要重新手动分组

### 1.1 现象

用户从智绘姬(st-chatu8)把 vibe 迁移到柏宝绘后,大量原本在智绘姬"组"里的 vibe 出现在柏宝绘的「未分组」里,组结构丢失,需要手工重新分组。

### 1.2 背景:智绘姬里"预设"和"组"是两个东西(这是根因的地基)

智绘姬(`st-chatu8/index.js`)里 vibe 有**两套互斥的数据结构**:

| | 预设 `vibePresets` | 组 `vibeGroups` |
|---|---|---|
| 用途 | NAI3 单 vibe 转移的"配置存档" | NAI4/4.5 多 vibe 组合方案 |
| 结构 | `{ [预设名]: { model, infoExtract, strength, imageId, vibeDataId } }` | `{ [组名]: { vibes: [{ vibeDataId, strength }], coverImageId } }` |
| 出图行为 | 当前选中的 1 个预设 → 发 **1 张**参考图 | 当前选中的 1 个组 → 发**组内全部**参考图 |
| 当前选中 | `vibePresetId` | `vibeGroupId`(可 `randomVibeGroup` 随机) |
| 关键代码 | `applySingleVibeTransfer`(仅 NAI3) | `applyVibeGroupTransfer`(仅 NAI4/4.5) |

- 两者出图时**互斥**:开 `enableVibeGroupTransfer`(组)会自动关 `nai3VibeTransfer`(单 vibe),见智绘姬 `index.js` L84931 附近。
- **同一个 `vibeDataId` 可以同时存在于预设和组里**(一边当 NAI3 单图,一边当 NAI4 组合成员)——这是迁移丢组的直接导火索,见 1.3-②。

智绘姬侧关键代码位置(`st-chatu8/index.js`):

- `L1723`:默认预设结构示例 `vibePresets: { "默认": { model, infoExtract, strength, imageId, vibeDataId } }`
- `L51918`:`vibePresets` 字段注释(官方说明)
- `L51826`:`enableVibeGroupTransfer` 字段注释(官方说明)
- `L6833~6852`:`getRandomVibeGroupId`(随机组)
- `L64535~64579`:`ensureVibeGroupPresets`(组结构初始化,含"默认组")
- `L67334`:`applySingleVibeTransfer`(NAI3 单 vibe:只 push 一张图)
- `L67405`:`applyVibeGroupTransfer`(NAI4/4.5 组转移:遍历组内全部 vibe 取编码后全发)
- `L68059~68067`:出图时分流(组 / 单 vibe / 角色参考,互斥分支)
- `L84931~84950`:开关互斥逻辑(开组关单,开单关组)

### 1.3 柏宝绘侧根因(三层叠加)

#### ① 历史版本的结构缺失(存量用户主因)

- 柏宝绘 v0.1.2(`6e11861` 提交)及更早:迁移代码没有 `group` 字段,组名被**拼进显示名**,格式「组名 · 原名」(旧代码:`${ref.source} · ${parsed.name}`)。
- v0.1.3(`89b2840` 提交)才引入真正的 `group` 字段,并加了补救按钮「按名称整理分组」,靠识别「 · 」前缀还原。
- 补救的死角:
  - 按钮是条件渲染的小按钮(有可整理条目才出现),不显眼,很多用户没点;
  - 用户若已手动改过名(前缀没了),自动整理永久失效;
  - `planPrefixGroups` 跳过「前缀或余名为空」的条目(旧版拼出的残缺名「组名 · 」无法还原);
  - 存量用户(v0.1.3 之前迁移、之后没点过按钮)现状就是全部堆在「未分组」。

#### ② 现版导入代码的去重缺陷(新迁移也会丢组,建议优先修)

柏宝绘 `src/backends/chatu8Vibe.ts` 的 `collectChatu8VibeRefs`:

- `L42`:函数入口
- `L47~50`:收集逻辑 —— `seen` 集合按 `vibeDataId` **全局去重**,且**预设先收集、预设优先**(注释明说"预设优先,命名更好看")。

后果:

- 同一 vibe 同时存在于「预设」和「组」时,只导入预设那条 → 导入时 `kind='preset'` → `group=''`(未分组),**组关系丢失**;
- 同一 vibe 出现在多个组时,只进第一个组,其余组静默丢成员;
- 迁移面板的计数(`detectChatu8Vibes`)也按同一去重口径,用户看到的"总数"和实际组结构对不上。

#### ③ 语义差异(迁移后观感不对的隐性原因)

- 智绘姬:组 = 整体方案,一次只出一个组,组内不可单独开关。
- 柏宝绘:组 = 标签,每条 vibe 独立 `enabled`,可多组叠加(「只开这组」才接近智绘姬的组语义)。
- 柏宝绘的「生效中」判定 `isGroupActive` 是"启用集合恰好等于全组"才算,与智绘姬"选中即整组生效"不同,用户会感觉组行为不一致。

### 1.4 柏宝绘侧代码位置

`src/backends/chatu8Vibe.ts`(迁移核心,纯逻辑):

- `L21`:`CHATU8_SETTINGS_KEY = 'st-chatu8'`(读智绘姬设置的命名空间键)
- `L42~78`:`collectChatu8VibeRefs` —— **去重缺陷所在地(L48 `seen.has` 全局去重、预设优先)**
- `L182`:`LEGACY_GROUP_SEPARATOR = ' · '`(旧版组名前缀分隔符)
- `L198~215`:`planPrefixGroups` —— 旧版「组名 · 原名」前缀还原,只动 `group` 为空的条目
- `L236~296`:`importVibesFromChatu8` —— 迁移主流程;`L282` 命名(预设用预设名/组内用文件原名)、`L289` 组赋值(`ref.kind === 'group' ? ref.source : ''`)

`src/pages/backend/panels/NaiPanel.vue`(UI 层):

- `L309~325`:`prefixGroupPlans` / `applyPrefixGroups` —— 「按名称整理分组」逻辑
- `L333~365`:`chatu8Detect` / `runMigrate` —— 迁移面板逻辑
- `L691~698`:整理分组按钮(条件渲染)
- `L846~886`:迁移面板模板(检测提示 / 确认弹窗 / 开始迁移)

`src/state/settings.ts`(数据结构):

- `L106~134`:`interface NaiVibe` —— `group` 字段在 `L134`(空串 = 未分组,扁平字符串设计,见 `L126~133` 注释)
- `L165`:`vibes: NaiVibe[]`(库本体)
- `L809~`:`normalizeVibe`(旧数据归一化入口,含 `group` 处理)

相关纯逻辑与测试(改完必跑):

- `src/backends/vibeGroups.ts`:`groupKey` / `matchVibe` / `groupVibes` / `isGroupActive`(分组渲染与生效判定)
- `src/backends/chatu8Vibe.test.ts`:`L32~40` 正是"预设优先去重"的现有测试(改行为需同步改)
- `src/backends/vibeGroups.test.ts`、`src/state/settings.vibeMigration.test.ts`

### 1.5 修复方向建议(供参考,未定稿)

1. **改去重策略**:组内引用不应被预设吞掉。可选:组优先;或同一 `vibeDataId` 同时出现在预设和组时,生成两条记录(预设一条未分组 + 组内一条带组名);或在导入结果里报告"N 个 vibe 因同时存在于预设与组,已按组导入"。
2. **迁移引导**:迁移完成后若有可整理的旧前缀名,弹提示引导用户点「按名称整理分组」,而不是把按钮藏在角落。
3. **残缺名兜底**:「组名 · 」这类余名为空的条目,考虑用文件原名或"未命名"兜底,使 `planPrefixGroups` 能处理。
4. (可选)迁移面板展示"将丢失组关系的 N 个"预警,让用户迁移前知情。

---

## 问题 2:Vibe 强度只能按 0.05(5%)步进调整,不能自由输入小数

### 2.1 现象

Vibe 强度滑块只能 0 / 0.05 / 0.10 … 1.00,无法拖出或输入 0.23 这类任意值。

### 2.2 根因

**纯 UI 层限制,数据层无任何限制**:

- 唯一入口是 `<input type="range" step="0.05">`,`step="0.05"` 把可取值锁死在 5% 步进;
- 数据层 `strength` 是普通 `number`,只做 0–1 clamp(`chatu8Vibe.ts` 的 `validStrength`),生成端(`src/backends/nai.ts` 的参考强度归一化)也接受任意小数。

### 2.3 代码位置

- `src/pages/backend/panels/NaiPanel.vue` **`L798`**:
  `<input type="range" min="0" max="1" step="0.05" v-model.number="vibe.strength" />`
  (强度显示 `L797`:`强度 {{ vibe.strength.toFixed(2) }}`)
- 样式:`L1000~1015` 附近 `.vibe-strength` 相关 CSS
- 注意:**`L620` 的 `step="0.05"` 是 cfgRescale(相关性调整)的数字输入框,可自由输入,不是本问题**,别误改。

### 2.4 修复方向建议

1. 滑块旁加一个配套数字输入框(min 0 / max 1 / step 任意,如 0.01),与滑块双向同步(v-model 共用 `vibe.strength` 即可);
2. 或直接把滑块 `step` 改细(如 `0.01`),但拖动手感会变差,推荐方案 1;
3. 强度显示已有 `toFixed(2)`,输入框建议也限制 2 位小数(输入时 clamp 到 [0,1])。

---

## 附:验证与自测清单

1. 构造智绘姬设置:同一 `vibeDataId` 同时出现在 `vibePresets` 和 `vibeGroups` 的某个组里 → 迁移后该 vibe 应出现在对应组(按新策略)而非未分组。
2. 旧库场景:把 `settings.nai.vibes` 里某条 `group=''`、`name='战斗组 · 剑风'` → 「按名称整理分组」按钮应出现,点击后 `group='战斗组'`、`name='剑风'`。
3. 残缺名:`name='战斗组 · '` → 按新兜底策略应能被整理(当前会被跳过)。
4. 强度:拖滑块与输入框互相同步;输入 `0.23` 后出图请求里 `reference_strength_multiple` 含 `0.23`(归一化开关关闭时)。
5. 回归:跑 `pnpm test`(vitest),重点 `chatu8Vibe.test.ts` / `vibeGroups.test.ts` / `settings.vibeMigration.test.ts`。
