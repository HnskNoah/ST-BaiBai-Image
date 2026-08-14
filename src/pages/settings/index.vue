<script setup lang="ts">
import BbiSelect from '@/components/BbiSelect.vue';
import Collapsible from '@/components/Collapsible.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { fetchModels, testChannel } from '@/api/client';
import {
  BACKENDS,
  DEFAULT_COMFY_SPEC,
  DEFAULT_JAILBREAK_PROMPT,
  newChannel,
  settings,
  type ApiChannel,
  type AutoTagPrompts,
  type BackendId,
} from '@/state/settings';
import {
  ORB_SHAPES,
  THEMES,
  ui,
  type NavPosition,
  type OrbShape,
  type ThemeName,
} from '@/state/ui';
import { PLUGIN_VERSION } from '@/version';
import { computed, nextTick, ref } from 'vue';

const NAV_OPTIONS: { value: NavPosition; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'top', label: '顶部' },
  { value: 'bottom', label: '底部' },
];

// 出图后端可选项:与渠道页页签同口径,藏掉未开放的 webui
const BACKEND_OPTIONS = BACKENDS.filter(b => b.value !== 'webui');

/* —— 自绘下拉(BbiSelect)的 v-model 适配:组件按 string 收发,这里收窄回具体联合类型 —— */
const themeSel = computed<string>({
  get: () => ui.theme,
  set: v => (ui.theme = v as ThemeName),
});
const navSel = computed<string>({
  get: () => ui.navPosition,
  set: v => (ui.navPosition = v as NavPosition),
});
const orbShapeSel = computed<string>({
  get: () => ui.orbShape,
  set: v => (ui.orbShape = v as OrbShape),
});
const backendSel = computed<string>({
  get: () => settings.defaultBackend,
  set: v => (settings.defaultBackend = v as BackendId),
});

/* —— 渠道:列表只读展示,编辑/新建都在弹窗里进行,避免一长列表平铺误触。
   渠道列表与柏宝书共享(见 state/settings.ts 的共享存储),任一端改动自动同步。 —— */
// editingId:正在编辑的「已有渠道」id;新建时为 null。仅用于「完成」时定位写回目标。
const editingId = ref<string | null>(null);
// 编辑用「草稿副本」:v-model 全改在草稿上,只有点「完成」才写回 settings(避免每敲一字就触发存盘)。
// 弹窗开关也以它为准:草稿存在 = 弹窗打开。
const editingChannel = ref<ApiChannel | null>(null);
// 深拷贝渠道(纯数据,JSON 即可),切断与 settings 真身的引用
function cloneChannel(ch: ApiChannel): ApiChannel {
  return JSON.parse(JSON.stringify(ch)) as ApiChannel;
}
// 密钥默认隐藏;每次打开/关闭弹窗都复位,避免密钥意外保持明文
const showKey = ref(false);

function normalizeAutoTagNumbers() {
  settings.autoTag.contextMessages = Math.max(1, Math.floor(Number(settings.autoTag.contextMessages) || 1));
  settings.autoTag.maxImages = Math.max(1, Math.floor(Number(settings.autoTag.maxImages) || 1));
}

/* —— 自定义提示词(UI 照搬柏宝书):列表只读展示,编辑在弹窗里进行。
   空串 = 回落内置默认;是否已自定义按 trim 非空判定。 —— */
interface TagPromptMeta {
  key: keyof AutoTagPrompts;
  label: string;
  hint: string;
  builtin: string;
  macros: { token: string; desc: string }[];
}

const TAG_PROMPT_METAS: TagPromptMeta[] = [
  {
    key: 'jailbreak',
    label: '破限词',
    hint: '作为置顶 system 附加在自动 tag 请求里，降低副 API 拒答率。留空则用内置默认（与柏宝书同款文本）。',
    builtin: DEFAULT_JAILBREAK_PROMPT,
    macros: [],
  },
  {
    key: 'naiSpec',
    label: 'NAI 规范',
    hint: '发给 NAI 后端时使用的 tag 书写规范，拼在任务提示词里。内置内容待定，留空暂不附加。',
    builtin: '',
    macros: [],
  },
  {
    key: 'comfySpec',
    label: 'ComfyUI 规范',
    hint: '默认后端为 ComfyUI 时拼进自动 tag 请求，约束 tag / nl 的书写规范。留空用内置默认。',
    builtin: DEFAULT_COMFY_SPEC,
    macros: [
      {
        token: '{{nl}}',
        desc: '自然语言规范；ComfyUI 面板开启「生成自然语言」时展开，关闭时置空。不写此宏时，开启开关会自动追加到末尾。',
      },
    ],
  },
  {
    key: 'thinking',
    label: '思维链',
    hint: '输出前思考检查清单，作为 system 消息压在任务消息之后，要求模型先在 <thinking> 内过检查点再输出 JSON。内置内容待定，留空暂不附加。',
    builtin: '',
    macros: [],
  },
  {
    key: 'prefill',
    label: '预填充',
    hint: 'assistant 预填充，以 <thinking> 开头引导模型从思维链续写；随渠道「发送预填充」开关生效。内置内容待定，留空暂不附加。',
    builtin: '',
    macros: [],
  },
];

// 正在编辑的提示词;draft 是草稿,点「完成」才写回 settings(取消则丢弃)。
const editingTagPrompt = ref<TagPromptMeta | null>(null);
const tagPromptDraft = ref('');
const tagPromptArea = ref<HTMLTextAreaElement | null>(null);

// 该条是否已自定义(非空即视为已覆盖内置)
function isTagPromptCustom(key: keyof AutoTagPrompts): boolean {
  return settings.autoTag.prompts[key].trim().length > 0;
}

function openTagPrompt(meta: TagPromptMeta) {
  editingTagPrompt.value = meta;
  // 已自定义→载入用户内容;未自定义→预填内置模板,方便直接在其上改
  tagPromptDraft.value = settings.autoTag.prompts[meta.key].trim() || meta.builtin;
}
function closeTagPrompt() {
  editingTagPrompt.value = null;
  tagPromptDraft.value = '';
}
function saveTagPrompt() {
  const meta = editingTagPrompt.value;
  if (!meta) return;
  // 草稿与内置完全一致→存空串(回落内置),避免把模板冗余存进设置、也便于显示「默认」
  const v = tagPromptDraft.value.trim();
  settings.autoTag.prompts[meta.key] = v === meta.builtin.trim() ? '' : tagPromptDraft.value;
  closeTagPrompt();
}
// 「恢复默认」:把草稿重置回内置模板(保存后即回落内置)
function resetTagPromptDraft() {
  if (editingTagPrompt.value) tagPromptDraft.value = editingTagPrompt.value.builtin;
}
// 点宏标签 → 插入到文本框光标处(无焦点则追加到末尾)
function insertTagMacro(token: string) {
  const el = tagPromptArea.value;
  if (!el) {
    tagPromptDraft.value += token;
    return;
  }
  const start = el.selectionStart ?? tagPromptDraft.value.length;
  const end = el.selectionEnd ?? start;
  tagPromptDraft.value = tagPromptDraft.value.slice(0, start) + token + tagPromptDraft.value.slice(end);
  // 等 v-model 回填后把光标移到插入内容之后
  void nextTick(() => {
    el.focus();
    const pos = start + token.length;
    el.setSelectionRange(pos, pos);
  });
}

// 排除参数:内部存 string[],编辑时用逗号分隔的单行文本承载,读/写两向转换。
const excludeParamsText = computed<string>({
  get: () => editingChannel.value?.excludeParams.join(', ') ?? '',
  set: v => {
    const ch = editingChannel.value;
    if (!ch) return;
    ch.excludeParams = v
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  },
});

function addChannel() {
  showKey.value = false;
  editingId.value = null; // null = 新建,完成时 push
  editingChannel.value = newChannel(); // 草稿,尚未进 settings
}
function openChannel(id: string) {
  const src = settings.channels.find(c => c.id === id);
  if (!src) return;
  showKey.value = false;
  editingId.value = id;
  editingChannel.value = cloneChannel(src); // 编辑草稿副本,不动真身
}
/** 取消(× / 点遮罩):丢弃草稿,不写回 settings(无论新建还是编辑,改动都作废)。 */
function closeChannel() {
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
/** 完成:把草稿写回 settings —— 新建则 push,编辑则按 id 覆盖。此时才触发存盘。 */
function confirmChannel() {
  const draft = editingChannel.value;
  if (draft) {
    draft.timeoutSec =
      Number.isFinite(draft.timeoutSec) && draft.timeoutSec > 0
        ? Math.floor(draft.timeoutSec)
        : 180;
    const list = settings.channels;
    if (editingId.value) {
      const idx = list.findIndex(c => c.id === editingId.value);
      if (idx >= 0) list[idx] = draft;
      else list.push(draft); // 编辑期间原渠道被删等异常 → 兜底为新增
    } else {
      list.push(draft);
    }
  }
  showKey.value = false;
  editingId.value = null;
  editingChannel.value = null;
}
// 删除渠道前的二次确认:点删除先开确认弹窗,确认后才真正删。
const confirmDeleteOpen = ref(false);
function askRemoveChannel() {
  confirmDeleteOpen.value = true;
}
function confirmRemoveChannel() {
  confirmDeleteOpen.value = false;
  // 删除针对「已有渠道」(editingId);新建草稿尚未入库,等同直接丢弃草稿
  if (editingId.value) removeChannel(editingId.value);
  editingId.value = null;
  editingChannel.value = null;
}
function removeChannel(id: string) {
  const list = settings.channels;
  const idx = list.findIndex(c => c.id === id);
  if (idx >= 0) list.splice(idx, 1);
  // 清理指派:生成 tag 若指派了该渠道则清空(回落跟随主 API)
  if (settings.assignments.tagGen === id) settings.assignments.tagGen = '';
}

const testing = ref<Record<string, string>>({});
async function doTest(ch: ApiChannel) {
  testing.value[ch.id] = '测试中…';
  const r = await testChannel(ch);
  testing.value[ch.id] = r.message;
}

// 各渠道拉取到的模型列表 + 拉取状态
const models = ref<Record<string, string[]>>({});
const loadingModels = ref<Record<string, boolean>>({});
async function pullModels(ch: ApiChannel) {
  loadingModels.value[ch.id] = true;
  testing.value[ch.id] = '';
  try {
    const list = await fetchModels(ch);
    models.value[ch.id] = list;
    if (list.length && !ch.model) ch.model = list[0];
    if (!list.length) testing.value[ch.id] = '未返回任何模型';
  } catch (e) {
    testing.value[ch.id] = e instanceof Error ? e.message : String(e);
  } finally {
    loadingModels.value[ch.id] = false;
  }
}

/* —— 模型可搜索下拉(combobox):输入框既是当前值也是过滤词,聚焦弹出过滤列表 —— */
const modelMenuOpen = ref(false);
const modelQuery = ref(''); // 聚焦后用户输入的过滤词;失焦时清空
// 已拉取到的当前渠道模型列表
const modelList = computed<string[]>(() => {
  const id = editingChannel.value?.id;
  return id ? models.value[id] ?? [] : [];
});
// 过滤:有 query 按子串(大小写不敏感)过滤;为空则显示全部。性能上限 200 条,避免超长列表卡顿。
const filteredModels = computed<string[]>(() => {
  const q = modelQuery.value.trim().toLowerCase();
  const list = modelList.value;
  const out = q ? list.filter(m => m.toLowerCase().includes(q)) : list;
  return out.slice(0, 200);
});
function openModelMenu() {
  modelQuery.value = '';
  modelMenuOpen.value = true;
}
function pickModel(m: string) {
  if (editingChannel.value) editingChannel.value.model = m;
  modelMenuOpen.value = false;
  modelQuery.value = '';
}
// 失焦延迟关闭,让 option 的 mousedown/click 先生效
function closeModelMenuSoon() {
  setTimeout(() => {
    modelMenuOpen.value = false;
    modelQuery.value = '';
  }, 150);
}
</script>

<template>
  <section class="bbi-page">
    <!-- 标题行:左标题 + 右版本号 -->
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">设置</h2>
      <span class="bbi-ver" title="当前版本">v{{ PLUGIN_VERSION }}</span>
    </div>
    <hr class="bbi-rule" />

    <!-- 总开关:整个插件的主控。全页唯一的大号滑动开关,与下方各项的小复选框拉开层级。 -->
    <div class="bbi-master" :class="{ 'is-off': !settings.enabled }">
      <span class="bbi-master-spine" aria-hidden="true"></span>
      <span class="bbi-master-title">柏宝绘 · 文生图</span>
      <button
        type="button"
        role="switch"
        class="bbi-toggle"
        :class="{ 'is-on': settings.enabled }"
        :aria-checked="settings.enabled"
        :title="settings.enabled ? '点击停用' : '点击启用'"
        @click="settings.enabled = !settings.enabled"
      >
        <span class="bbi-toggle-knob"></span>
      </button>
    </div>

    <div class="bbi-sections">
      <!-- 基本设置:主题 / 导航 / 入口 / 悬浮球等界面项,置于首位 -->
      <Collapsible title="基本设置" :open="false">
        <div class="bbi-select-row">
          <span class="bbi-field-label">主题</span>
          <BbiSelect v-model="themeSel" :options="THEMES" aria-label="主题" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">导航位置</span>
          <BbiSelect v-model="navSel" :options="NAV_OPTIONS" aria-label="导航位置" />
        </div>

        <div class="bbi-select-row">
          <span class="bbi-field-label">出图后端</span>
          <BbiSelect v-model="backendSel" :options="BACKEND_OPTIONS" aria-label="出图后端" />
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">移动端点当前页导航关窗</span>
          <input v-model="ui.navTapClose" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">移动端再点一下当前所在页的导航按钮即可关闭整个窗口,省得去够右上角的 ×。怕误触可关。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">在 ST 顶栏显示按钮</span>
          <input v-model="ui.showTopBar" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">在酒馆顶部导航栏加一个快速打开柏宝绘的按钮。左下角魔杖入口照旧保留。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">显示屏幕悬浮球</span>
          <input v-model="ui.showOrb" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">在屏幕边缘挂一枚可拖动的悬浮球,点击即开柏宝绘。拖到中间可常驻悬浮,拖近左右边缘则吸附贴边。</p>

        <!-- 悬浮球外观:配置项多,开启后才收进小分组 -->
        <Collapsible v-if="ui.showOrb" title="悬浮球外观" :open="false">
          <div class="bbi-select-row">
            <span class="bbi-field-label">形状</span>
            <BbiSelect v-model="orbShapeSel" :options="ORB_SHAPES" aria-label="悬浮球形状" />
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">大小</span>
              <span class="bbi-field-value">{{ ui.orbSize }}px</span>
            </div>
            <input class="bbi-range" type="range" min="32" max="80" step="1" v-model.number="ui.orbSize" />
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">静止透明度</span>
              <span class="bbi-field-value">{{ ui.orbOpacity }}%</span>
            </div>
            <input class="bbi-range" type="range" min="20" max="100" step="1" v-model.number="ui.orbOpacity" />
            <p class="bbi-field-hint">悬浮球静止时的不透明度;唤起 / 拖动时一律全显。</p>
          </div>

          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">自定义图标</span>
            </div>
            <input class="bbi-input" type="text" v-model="ui.orbImage" placeholder="ST 服务器图片路径" spellcheck="false" />
            <p class="bbi-field-hint">留空用默认画笔图标。</p>
          </div>
        </Collapsible>
      </Collapsible>

      <Collapsible title="自动生成 tag" :open="false">
        <label class="bbi-switch-row">
          <span class="bbi-field-label">新 AI 正文完成后自动分析</span>
          <input v-model="settings.autoTag.enabled" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">使用独立请求判断最新 AI 楼层是否需要插图；这一阶段只写入 tag，暂不自动调用生图后端。</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">携带最近楼层数</span>
          <input
            v-model.number="settings.autoTag.contextMessages"
            class="bbi-input bbi-num"
            type="number"
            min="1"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="bbi-field-hint">发送目标楼及其之前最近多少层完整正文。所选楼层发送完整正文，不设置字符或 token 截断上限。</p>

        <label class="bbi-num-row">
          <span class="bbi-field-label">单楼最多图片数</span>
          <input
            v-model.number="settings.autoTag.maxImages"
            class="bbi-input bbi-num"
            type="number"
            min="1"
            step="1"
            @change="normalizeAutoTagNumbers"
          />
        </label>
        <p class="bbi-field-hint">单楼允许模型选择的最大画面数;模型不会为了凑满上限而硬选。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">读取柏宝书状态</span>
          <input v-model="settings.autoTag.useBaiBaiBook" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">柏宝书可用时按最新楼层是否已有摘要，自动使用 D1 / D2 对应的状态快照；不可用时仅发送最近正文。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">注入世界书 / 角色卡 / 用户人设</span>
          <input type="checkbox" class="bbi-checkbox" checked disabled />
        </label>
        <p class="bbi-field-hint">与柏宝书摘要请求同口径：世界书按关键词+常驻蓝灯激活并渲染，角色卡描述与用户人设自动附带；取不到或群聊时自动跳过。</p>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">渲染世界书模板（展宏 + 执行 EJS）</span>
          <input v-model="settings.autoTag.renderWorldInfoTemplates" type="checkbox" class="bbi-checkbox" />
        </label>
        <p class="bbi-field-hint">取世界书条目前先展开 &#123;&#123;宏&#125;&#125; 并执行 ST-Prompt-Template 的 EJS，拿到“执行后”的成品；未装模板插件时仅展宏。含写变量的 EJS 每次自动 tag 会额外执行一次，遇到这类世界书可关掉。</p>
      </Collapsible>

      <!-- 自定义提示词(与柏宝书同款入口,独立成区) -->
      <Collapsible title="自定义提示词" :open="false">
        <ul class="bbi-prompt-list">
          <li v-for="m in TAG_PROMPT_METAS" :key="m.key" class="bbi-prompt-item">
            <button class="bbi-prompt-open" type="button" @click="openTagPrompt(m)">
              <span class="bbi-prompt-name">{{ m.label }}</span>
              <span class="bbi-prompt-state" :class="{ 'is-custom': isTagPromptCustom(m.key) }">
                {{ isTagPromptCustom(m.key) ? '已自定义' : '默认' }}
              </span>
              <Icon name="edit" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>
        <p class="bbi-field-hint">留空 = 回落内置默认。破限词内置与柏宝书同款；NAI / ComfyUI 规范、思维链与预填充的内置内容待定，当前为空。</p>
      </Collapsible>

      <!-- 副 API:生成画图 tag 用的模型渠道(与柏宝书共享渠道列表) -->
      <Collapsible title="副 API" :open="false">
        <!-- 任务指派:只有一个任务——生成 tag -->
        <div class="bbi-field bbi-assign">
          <label class="bbi-assign-row">
            <span class="bbi-field-label">生成 tag 使用</span>
            <select v-model="settings.assignments.tagGen" class="bbi-input bbi-select">
              <option value="">跟随主 API</option>
              <option v-for="c in settings.channels" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </label>
        </div>
        <p class="bbi-field-hint">不指派渠道时跟随主 API:直接借用你主界面当前正在用的 API(聊天补全/文本补全)来生成画图 tag,无需额外配置。想用不同模型再在下方建副渠道指派。渠道列表与柏宝书共享,任一端改动都会自动同步到另一端。</p>

        <hr class="bbi-rule" />

        <!-- 渠道:顶部添加按钮 + 紧凑只读列表(点行进弹窗编辑),不再一长列表平铺 -->
        <div class="bbi-channel-bar">
          <span class="bbi-field-label">渠道</span>
          <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addChannel()">
            <Icon name="plus" /> 添加渠道
          </button>
        </div>

        <ul v-if="settings.channels.length" class="bbi-channel-list">
          <li v-for="ch in settings.channels" :key="ch.id" class="bbi-channel-item">
            <button class="bbi-channel-open" type="button" @click="openChannel(ch.id)">
              <span class="bbi-channel-item-name">{{ ch.name || '未命名渠道' }}</span>
              <span class="bbi-channel-item-model">{{ ch.model || '未设模型' }}</span>
            </button>
          </li>
        </ul>
        <p v-else class="bbi-field-hint">还没有渠道。点「添加渠道」配置生成 tag 要用的 API。</p>
      </Collapsible>
    </div>

    <!-- ===== 渠道编辑弹窗 ===== -->
    <ModalMask :open="!!editingChannel" @close="closeChannel">
      <div v-if="editingChannel" class="bbi-modal" role="dialog" aria-modal="true" aria-label="编辑渠道">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">编辑渠道</span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeChannel"><Icon name="close" /></button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">渠道名</span>
          <input v-model="editingChannel.name" class="bbi-input" placeholder="渠道名" />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">API 地址</span>
          <input v-model="editingChannel.url" class="bbi-input" placeholder="如 https://api.openai.com/v1" />
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">API 密钥</span>
          <div class="bbi-model-row">
            <input
              v-model="editingChannel.key"
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              placeholder="API 密钥"
            />
            <button
              class="bbi-icon-mini"
              type="button"
              :title="showKey ? '隐藏密钥' : '显示密钥'"
              :aria-pressed="showKey"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
        </label>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">模型</span>
          <div class="bbi-model-row">
            <!-- 可搜索 combobox:已拉取到模型列表时,聚焦弹出过滤菜单;没列表时就是普通输入框 -->
            <div class="bbi-combo">
              <input
                v-model="editingChannel.model"
                class="bbi-input"
                :placeholder="modelList.length ? '搜索或输入模型名…' : '模型名,如 gpt-4o-mini'"
                @focus="openModelMenu"
                @input="modelQuery = editingChannel.model; modelMenuOpen = true"
                @blur="closeModelMenuSoon"
              />
              <!-- 自绘下拉三角(纯装饰,pointer-events:none → 点击穿透到输入框照常聚焦展开);仅在有可选模型时显示 -->
              <span v-if="modelList.length" class="bbi-combo-caret" :class="{ 'is-open': modelMenuOpen }" aria-hidden="true" />
              <ul v-if="modelMenuOpen && modelList.length" class="bbi-combo-menu">
                <li v-if="!filteredModels.length" class="bbi-combo-empty">无匹配模型</li>
                <li
                  v-for="m in filteredModels"
                  :key="m"
                  class="bbi-combo-item"
                  :class="{ 'is-active': m === editingChannel.model }"
                  @mousedown.prevent="pickModel(m)"
                >
                  {{ m }}
                </li>
              </ul>
            </div>
            <button
              class="bbi-icon-mini"
              type="button"
              :title="loadingModels[editingChannel.id] ? '拉取中…' : '拉取模型'"
              :disabled="loadingModels[editingChannel.id]"
              @click="pullModels(editingChannel)"
            >
              <Icon name="refresh" />
            </button>
          </div>
        </label>
        <div class="bbi-channel-row">
          <label class="bbi-mini-field">
            <span>温度</span>
            <input v-model.number="editingChannel.temperature" class="bbi-input" type="number" step="0.1" min="0" max="2" />
          </label>
          <label class="bbi-mini-field">
            <span>最大 token</span>
            <input v-model.number="editingChannel.maxTokens" class="bbi-input" type="number" step="256" min="256" />
          </label>
          <label class="bbi-mini-field">
            <span>超时(秒)</span>
            <input v-model.number="editingChannel.timeoutSec" class="bbi-input" type="number" step="10" min="1" />
          </label>
        </div>
        <label class="bbi-switch-row">
          <span class="bbi-modal-label">流式传输</span>
          <input v-model="editingChannel.stream" type="checkbox" class="bbi-checkbox" />
        </label>
        <label class="bbi-switch-row">
          <span class="bbi-modal-label">发送预填充</span>
          <input v-model="editingChannel.prefill" type="checkbox" class="bbi-checkbox" />
        </label>
        <span class="bbi-field-hint">默认开。若副 API 报错信息里出现 prefill 字样,关掉它即可。</span>
        <label class="bbi-modal-field">
          <span class="bbi-modal-label">排除参数</span>
          <input
            v-model="excludeParamsText"
            class="bbi-input"
            type="text"
            placeholder="逗号分隔,如 temperature, max_tokens"
          />
          <span class="bbi-field-hint">这些参数会在发请求前从请求体里删除,用于规避不接受该参数的兼容端点报错。逗号分隔,留空则不排除。</span>
        </label>
        <p v-if="testing[editingChannel.id]" class="bbi-channel-test">{{ testing[editingChannel.id] }}</p>

        <footer class="bbi-modal-foot">
          <!-- 删除靠左、与右侧主操作拉开,破坏性动作不与「完成」相邻,降低误触。
               删除:始终显示文字;测试:PC 显「测试渠道」,移动端只显「测试」(短版,省版面) -->
          <button class="bbi-btn bbi-btn-danger" type="button" @click="askRemoveChannel">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" title="测试渠道" @click="doTest(editingChannel)">
            <Icon name="plug" /> <span class="bbi-btn-label-full">测试渠道</span><span class="bbi-btn-label-short">测试</span>
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmChannel">完成</button>
        </footer>

        <!-- 删除渠道二次确认:叠在渠道弹窗之上。置于 v-if="editingChannel" 块内,
             渠道为 null 时整体不渲染——既合语义,也让 editingChannel.name 类型收窄。
             ConfirmDialog 自身 teleport + top-layer,放这儿不影响其渲染层级。 -->
        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除渠道"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemoveChannel"
        >
          确定删除渠道「{{ editingChannel.name || '未命名渠道' }}」吗?此操作不可撤销,已指派该渠道的任务会被清空。
        </ConfirmDialog>
      </div>
    </ModalMask>

    <!-- ===== 自定义提示词编辑弹窗(UI 照搬柏宝书) ===== -->
    <ModalMask :open="!!editingTagPrompt" @close="closeTagPrompt">
      <div
        v-if="editingTagPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`编辑${editingTagPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">编辑{{ editingTagPrompt.label }}</span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeTagPrompt"><Icon name="close" /></button>
        </header>

        <p class="bbi-modal-label">{{ editingTagPrompt.hint }}</p>

        <!-- 可用宏:点一下插入到光标处(当前各条暂无宏,留空不显示) -->
        <div v-if="editingTagPrompt.macros.length" class="bbi-macro-bar">
          <span class="bbi-macro-tip">点击插入宏:</span>
          <button
            v-for="mac in editingTagPrompt.macros"
            :key="mac.token"
            class="bbi-macro"
            type="button"
            :title="mac.desc"
            @click="insertTagMacro(mac.token)"
          >
            {{ mac.token }}
          </button>
        </div>

        <textarea
          ref="tagPromptArea"
          v-model="tagPromptDraft"
          class="bbi-input bbi-prompt-area"
          spellcheck="false"
          rows="16"
        ></textarea>

        <footer class="bbi-modal-foot">
          <button class="bbi-btn bbi-btn-danger" type="button" @click="resetTagPromptDraft">
            <Icon name="refresh" /> 恢复默认
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeTagPrompt">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="saveTagPrompt">完成</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* —— 版本标签:实心强调底 + 反白字,各主题随 --bbi-accent 自适应 —— */
.bbi-ver {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent);
  color: var(--bbi-accent-ink);
  cursor: default;
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

/* —— 总开关主控卡 —— */
/* 左缘一道强调色竖脊;停用时整卡褪色、竖脊转灰,状态一眼可辨 */
.bbi-master {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 16px;
  padding: 16px 18px 16px 16px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface);
  box-shadow: var(--bbi-shadow);
  transition: opacity var(--bbi-dur) var(--bbi-ease);
}
.bbi-master-spine {
  flex: 0 0 auto;
  align-self: stretch;
  width: 4px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-accent);
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-master.is-off .bbi-master-spine {
  background: var(--bbi-line-strong);
}
.bbi-master.is-off .bbi-master-title {
  opacity: 0.7;
}
.bbi-master-title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--bbi-ink);
}

.bbi-auto-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 4px 0 8px;
}

/* —— 滑动开关:全页仅总开关一处使用 —— */
.bbi-toggle {
  flex: 0 0 auto;
  position: relative;
  width: 46px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-line-strong);
  cursor: pointer;
  transition: background var(--bbi-dur) var(--bbi-ease);
}
.bbi-toggle.is-on {
  background: var(--bbi-accent);
}
.bbi-toggle:focus-visible {
  outline: 2px solid var(--bbi-accent);
  outline-offset: 2px;
}
.bbi-toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--bbi-surface);
  box-shadow: 0 1px 3px oklch(0 0 0 / 0.25);
  transition: transform var(--bbi-dur) var(--bbi-ease);
}
.bbi-toggle.is-on .bbi-toggle-knob {
  transform: translateX(20px);
}

/* ============ 副 API:渠道(与柏宝书同款) ============ */

/* 任务指派 */
.bbi-assign {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bbi-assign-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
/* 指派下拉:比全局 bbi-select 更窄小一号,与右侧对齐、不撑满半行(柏宝书同款) */
.bbi-assign-row .bbi-select {
  max-width: 60%;
  font-size: 12px;
}

/* 渠道:顶部操作条(标签 + 添加按钮) */
.bbi-channel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

/* 渠道:紧凑只读列表,每渠道一行,点行进弹窗编辑 */
.bbi-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-channel-item {
  display: flex;
  align-items: stretch;
  gap: 8px;
}
/* 行主体:整块可点,左名字右模型 */
.bbi-channel-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbi-dur) var(--bbi-ease), background var(--bbi-dur) var(--bbi-ease);
}
.bbi-channel-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
/* 渠道名:完整显示,允许换行,占据剩余空间 */
.bbi-channel-item-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* 模型名:次要信息,过长则截断,不挤占名字 */
.bbi-channel-item-model {
  flex: 0 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 渠道编辑弹窗 —— */
.bbi-model-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.bbi-model-row .bbi-input {
  flex: 1;
}
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}
.bbi-icon-mini:disabled {
  opacity: 0.5;
  cursor: default;
}

/* —— 模型可搜索 combobox —— */
.bbi-combo {
  position: relative;
  flex: 1;
  min-width: 0;
}
.bbi-combo .bbi-input {
  width: 100%;
  padding-right: 26px; /* 给右侧自绘三角让位,文字不压到箭头 */
}
/* 自绘下拉三角:与原生 <select> 同款 SVG,贴右侧居中;展开时翻转。装饰元素不拦点击 */
.bbi-combo-caret {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 14px;
  height: 14px;
  transform: translateY(-50%);
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9.5 12 15.5 18 9.5'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px;
  transition: transform 0.15s ease;
}
.bbi-combo-caret.is-open {
  transform: translateY(-50%) rotate(180deg);
}
/* 过滤菜单:绝对定位贴在输入框下方,限高滚动,长列表不撑爆弹窗 */
.bbi-combo-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 6;
  list-style: none;
  margin: 0;
  padding: 4px;
  max-height: 220px;
  overflow-y: auto;
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  box-shadow: var(--bbi-shadow);
}
.bbi-combo-item {
  padding: 7px 9px;
  border-radius: var(--bbi-radius-sm);
  font-size: 12.5px;
  color: var(--bbi-ink);
  cursor: pointer;
  word-break: break-all;
}
.bbi-combo-item:hover {
  background: var(--bbi-surface-2);
}
.bbi-combo-item.is-active {
  color: var(--bbi-accent);
  font-weight: 600;
}
.bbi-combo-empty {
  padding: 7px 9px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}

/* 温度/最大 token/超时:三个短输入并排 */
.bbi-channel-row {
  display: flex;
  gap: 10px;
}
.bbi-mini-field {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.bbi-channel-test {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbi-ink-soft);
  word-break: break-all;
}

/* 弹窗底部:spacer 把删除键推到最左,与右侧操作分隔 */
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮:描边低调,hover 才显红,避免误触 */
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

/* 测试按钮文字:默认(PC)显完整版,短版藏起;窄屏在媒体查询里互换 */
.bbi-btn-label-short {
  display: none;
}

/* —— 自定义提示词列表(UI 照搬柏宝书) —— */
.bbi-prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* 整行可点进弹窗编辑;布局沿用渠道列表的观感(描边、hover 显强调色) */
.bbi-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--bbi-dur) var(--bbi-ease), background var(--bbi-dur) var(--bbi-ease);
}
.bbi-prompt-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
.bbi-prompt-name {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
}
/* 状态药丸:默认 muted,已自定义转金强调 */
.bbi-prompt-state {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
}
.bbi-prompt-state.is-custom {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}

/* —— 提示词弹窗:更宽 + 大文本框 —— */
.bbi-modal-wide {
  max-width: 680px;
}
/* 宏标签条:可横向裹行,每个宏点击插入 */
.bbi-macro-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.bbi-macro-tip {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  margin-right: 2px;
}
.bbi-macro {
  padding: 3px 9px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  cursor: pointer;
  transition: color var(--bbi-dur) var(--bbi-ease), border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-macro:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
}
.bbi-prompt-area {
  resize: vertical;
  min-height: 240px;
  line-height: 1.6;
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}

/* ============ 移动端:折叠区内部正文整体收一号,与窄屏标题节奏统一 ============ */
@media (max-width: 640px) {
  .bbi-auto-grid {
    grid-template-columns: 1fr;
  }
  .bbi-channel-item-name {
    font-size: 13px;
  }
  .bbi-channel-item-model {
    font-size: 11px;
  }
  /* 渠道弹窗底部:测试按钮窄屏只显短版「测试」,PC 显完整「测试渠道」 */
  .bbi-btn-label-full {
    display: none;
  }
  .bbi-btn-label-short {
    display: inline;
  }
}
</style>
