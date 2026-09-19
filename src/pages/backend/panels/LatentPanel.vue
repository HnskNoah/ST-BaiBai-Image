<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Collapsible from '@/components/Collapsible.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import {
  artistForTarget,
  LATENT_SAMPLERS,
  LATENT_SCHEDULERS,
  latentAsNai,
  settings,
} from '@/state/settings';
import {
  isBuiltinLatentArtist,
  LATENT_DEFAULT_QUALITY_TAGS,
  latentDefaultUndesired,
} from '@/backends/nai';
import ArtistLibraryRow from '@/pages/backend/panels/ArtistLibraryRow.vue';
import {
  fetchLatentCaps,
  readLatentCaps,
  testLatentConnection,
  writeLatentCaps,
  type LatentCaps,
} from '@/backends/latentCaps';

/**
 * Latent 渠道:第三方站点 NovelAI 兼容面的精简适配。
 * 生成完全复用 NAI 机器(latentAsNai 映射后走 generateNaiImage),面板只暴露
 * 站点 openapi 真实存在的参数:无模型下拉(单模型站点,GenerationRequest 无 model 字段)、
 * 无 Scale(无 CFG 字段)、无尺寸输入(resolution 是枚举,按 tag 判向发 portrait/landscape)、
 * 无 Vibe、无 rescale/variety。画师串为**本渠道独立库**(settings.latent.artistPresets,
 * 内容按 Anima 口径写 @ 格式),管理 UI 与 NAI 渠道同形(ArtistLibraryRow + 库管理弹窗)。
 *
 * 采样器/噪声表枚举 = 参数域快照(latent.caps.v1,点「同步参数域」或测试连接时拉
 * 站点 /openapi.json 解析)→ 内置回落列表;**打开面板不拉取**(高频操作),新旧见状态行。
 */

const inUse = computed(() => settings.defaultBackend === 'latent');
const showKey = ref(false);
const testing = ref(false);

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testLatentConnection(settings.latent);
    // 测试连接里可能完成了参数域同步,就地刷新下拉数据源与状态行
    caps.value = readLatentCaps(settings.latent.url);
    toastr.success(result.message, 'Latent 连接');
  } catch (error) {
    toastr.error(errorMessage(error), 'Latent 连接失败');
  } finally {
    testing.value = false;
  }
}

/* —— 参数域(采样器/噪声表)同步:手动触发,无任何自动拉取 —— */
const caps = ref<LatentCaps | null>(readLatentCaps(settings.latent.url));
const syncing = ref(false);
// 快照按 origin 分键:地址改了,状态行与下拉要立刻切到新源站的快照(没有则回落内置),
// 否则会拿旧站快照冒充新地址的同步状态
watch(
  () => settings.latent.url,
  url => {
    caps.value = readLatentCaps(url);
  },
);

async function onSyncCaps() {
  if (syncing.value) return;
  syncing.value = true;
  try {
    const result = await fetchLatentCaps(settings.latent.url);
    writeLatentCaps(settings.latent.url, result);
    caps.value = result;
    toastr.success(
      `采样器 ${result.samplers.length} 个 / 噪声表 ${result.schedulers.length} 个`,
      '参数域已同步',
    );
  } catch (error) {
    toastr.error(errorMessage(error), '参数域同步失败');
  } finally {
    syncing.value = false;
  }
}

/** 上次同步的相对时间;从未同步给出指引。 */
const capsStatus = computed(() => {
  const c = caps.value;
  if (!c) return '未同步,使用内置参数域';
  const seconds = Math.max(0, Math.floor((Date.now() - c.fetchedAt) / 1000));
  const ago =
    seconds < 60
      ? '刚刚'
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} 分钟前`
        : seconds < 86400
          ? `${Math.floor(seconds / 3600)} 小时前`
          : seconds < 86400 * 30
            ? `${Math.floor(seconds / 86400)} 天前`
            : new Date(c.fetchedAt).toLocaleDateString();
  return `上次同步:${ago}`;
});

/** 下拉枚举:快照优先,内置回落;当前保存值不在列表时补一条选项,不静默丢弃。 */
function optionsWithCurrent(list: string[], current: string): { value: string; label: string }[] {
  const options = list.map(v => ({ value: v, label: v }));
  if (current && !list.includes(current)) {
    options.push({ value: current, label: `${current}(已保存,站点列表外)` });
  }
  return options;
}
const samplerOptions = computed(() =>
  optionsWithCurrent(caps.value?.samplers ?? LATENT_SAMPLERS, settings.latent.sampler),
);
const noiseOptions = computed(() =>
  optionsWithCurrent(caps.value?.schedulers ?? LATENT_SCHEDULERS, settings.latent.noiseSchedule),
);

/* —— 画师串(Latent 独立库,管理 UI 与 NAI 渠道同形;内置条只读) —— */
const artist = computed(() => artistForTarget('latent'));
const isBuiltin = computed(() => (artist.value ? isBuiltinLatentArtist(artist.value.id) : false));

/**
 * 绑定正/负面词(与 NAI 面板同机制):写入当前激活的 latent 条目,随画师串一起切换;
 * 空串 = 跟随下方渠道级设置。弹窗预填生效回落值(与 NaiPanel 的 openNaiPrompt 同款)。
 */
interface LatentPromptTarget {
  key: 'quality' | 'negative';
  label: string;
  hint: string;
  readonly?: boolean;
  fallback: () => string;
  read: () => string;
  write: (v: string) => void;
}

const artistBoundTargets = computed<LatentPromptTarget[]>(() => {
  const a = artist.value;
  if (!a) return [];
  const readonly = isBuiltin.value;
  return [
    {
      key: 'quality',
      label: '正面质量词',
      readonly,
      hint: readonly
        ? '内置条随插件版本更新不可改;复制一条自己的再绑。留空 = 用下方渠道级设置。'
        : '这份质量词随当前画师串一起切换。留空 = 用下方渠道级设置（渠道级也留空则用 Anima 推荐默认）。',
      fallback: () => settings.latent.qualityTags.trim() || LATENT_DEFAULT_QUALITY_TAGS,
      read: () => a.quality,
      write: v => (a.quality = v),
    },
    {
      key: 'negative',
      label: '负面提示词',
      readonly,
      hint: readonly
        ? '内置条随插件版本更新不可改;复制一条自己的再绑。留空 = 用下方渠道级设置。'
        : '这份负面词随当前画师串一起切换。留空 = 用下方渠道级设置（渠道级也留空则用 Anima 推荐默认）。',
      fallback: () =>
        settings.latent.negativePrompt.trim() || latentDefaultUndesired(latentAsNai()),
      read: () => a.negative,
      write: v => (a.negative = v),
    },
  ];
});

/**
 * 渠道级质量词/负面词(与 NAI 面板的 CHANNEL_PROMPT_TARGETS 同构):只读列表行,
 * 点行进弹窗编辑;画师串绑定了对应字段时,渠道值被覆盖(列表行显示警示徽标)。
 */
const channelPromptTargets = computed<LatentPromptTarget[]>(() => [
  {
    key: 'quality',
    label: '正面质量词',
    hint: '拼在画面 tag 之前（整体顺序：质量词 → 画师串 → 画面 tag）。留空 = 用 Anima 推荐默认（masterpiece, best quality, score_7）；分级词（safe / sensitive / nsfw / explicit）由 AI 按每张画面写,这里不必填——填了会与 AI 那份同时出现在提示词里。画师串里设置了质量词时,会用画师串那份,这里的不生效。',
    fallback: () => LATENT_DEFAULT_QUALITY_TAGS,
    read: () => settings.latent.qualityTags,
    write: v => (settings.latent.qualityTags = v),
  },
  {
    key: 'negative',
    label: '负面提示词',
    hint: '留空 = 用 Anima 推荐默认（启用画师串时自动剔除 artist name）。AI 会按画面生成画面级负面（仅排除画面相关项,通用质量词仍由这里/默认兜底）,与本条合并。画师串里设置了负面词时,会用画师串那份,这里的不生效。',
    fallback: () => latentDefaultUndesired(latentAsNai()),
    read: () => settings.latent.negativePrompt,
    write: v => (settings.latent.negativePrompt = v),
  },
]);

/** 当前画师串是否绑定了该字段——绑定时渠道值被覆盖,渠道行要说出这件事(与 NAI 同口径)。 */
function isShadowedByArtist(key: LatentPromptTarget['key']): boolean {
  const a = artist.value;
  if (!a) return false;
  return key === 'quality' ? !!a.quality.trim() : !!a.negative.trim();
}

function isTargetCustom(target: LatentPromptTarget): boolean {
  return target.read().trim().length > 0;
}

// 正在编辑的那条;draft 是草稿,点「完成」才写回条目(取消则丢弃)。
const editingPrompt = ref<LatentPromptTarget | null>(null);
const promptDraft = ref('');

function openPrompt(target: LatentPromptTarget) {
  editingPrompt.value = target;
  // 已自定义→载入用户内容;未自定义→预填下一级回落值,方便直接在其上改
  promptDraft.value = target.read().trim() || target.fallback();
}
function closePrompt() {
  editingPrompt.value = null;
  promptDraft.value = '';
}
function savePrompt() {
  const target = editingPrompt.value;
  if (!target) return;
  target.write(promptDraft.value);
  closePrompt();
}
function resetPromptDraft() {
  if (editingPrompt.value) promptDraft.value = editingPrompt.value.fallback();
}

</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      第三方站点的 NovelAI 兼容面精简适配:生成走 NAI 协议,参数由站点侧映射(尺寸/模型为站点固定档)。
    </p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">接口地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.latent.url"
            spellcheck="false"
          />
          <p class="bbi-field-hint">已内置站点兼容前缀,一般无需改动;自动补全 /ai/xxx 端点。</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="settings.latent.key"
              spellcheck="false"
            />
            <button
              class="bbi-btn"
              type="button"
              :title="showKey ? '隐藏' : '显示'"
              @click="showKey = !showKey"
            >
              <Icon :name="showKey ? 'eye-off' : 'eye'" />
            </button>
          </div>
          <p class="bbi-field-hint">在站点控制台创建;站点可能无订阅查询,测试连接会提示跳过。</p>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            @click="settings.defaultBackend = 'latent'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>
      </Collapsible>

      <Collapsible title="提示词" :open="false">
        <!-- Latent 独立画师串库(与 NAI 渠道的库互不相通):管理工具条/弹窗与 NAI 渠道同形 -->
        <ArtistLibraryRow target="latent" />
        <template v-if="artist">
          <BbiTextarea
            v-model="artist.prompt"
            :rows="3"
            :max-rows="8"
            mono
            :readonly="isBuiltin"
            placeholder="@artist_a, @artist_b"
          />
          <p v-if="isBuiltin" class="bbi-field-hint">
            内置条是 @ 格式的模板(@artist_name 为占位词),随插件版本更新不可直接改;复制一条后把占位词换成真实画师名。
          </p>
          <p v-else class="bbi-field-hint">
            Latent 底层是 Anima 系模型:画师 tag 用 <code>@名字</code> 格式(NAI 的 <code>artist:xxx</code> 写法无效),本渠道的画师串请按 @ 格式填写。
          </p>

          <!-- 随画师串一起切换的正/负面词（与 NAI 面板同机制）：设置了覆盖下面渠道级 -->
          <ul class="bbi-prompt-list">
            <li v-for="t in artistBoundTargets" :key="t.key" class="bbi-prompt-item">
              <button class="bbi-prompt-open" type="button" @click="openPrompt(t)">
                <span class="bbi-prompt-name">{{ t.label }}</span>
                <span class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                  {{ isTargetCustom(t) ? '已设置' : '未设置' }}
                </span>
                <Icon name="edit" class="bbi-prompt-edit" />
              </button>
            </li>
          </ul>
          <p class="bbi-field-hint">这里设置的提示词会覆盖下面的，随画师串一起切换;这里没设置，就会用下面的。</p>
        </template>

        <hr class="art-divider" />

        <!-- 渠道级质量词/负面词：只读列表行，点行进弹窗编辑（与 NAI 面板同款） -->
        <ul class="bbi-prompt-list">
          <li v-for="t in channelPromptTargets" :key="t.key" class="bbi-prompt-item">
            <button class="bbi-prompt-open" type="button" @click="openPrompt(t)">
              <span class="bbi-prompt-name">{{ t.label }}</span>
              <span v-if="isShadowedByArtist(t.key)" class="bbi-prompt-state is-shadowed">
                已被画师串覆盖
              </span>
              <span v-else class="bbi-prompt-state" :class="{ 'is-custom': isTargetCustom(t) }">
                {{ isTargetCustom(t) ? '已自定义' : '默认' }}
              </span>
              <Icon name="edit" class="bbi-prompt-edit" />
            </button>
          </li>
        </ul>
        <p class="bbi-field-hint">画师串里没设置正/负面词时，就会用这里的;这里也留空，则用 Anima 推荐默认。</p>

        <p class="bbi-field-hint">
          自动出图时教 AI 写 tag 的「规范/思维链」在 设置页 → 自定义提示词 → 「Latent 规范 / Latent 思维链」,留空走内置默认。
        </p>
      </Collapsible>

      <Collapsible title="默认参数" :open="false">
        <div class="caps-row">
          <span class="bbi-field-hint caps-status">{{ capsStatus }}</span>
          <button class="bbi-btn" type="button" :disabled="syncing" @click="onSyncCaps">
            <Icon name="refresh" :size="14" />
            {{ syncing ? '同步中…' : '同步参数域' }}
          </button>
        </div>
        <p class="bbi-field-hint">
          从站点 /openapi.json 拉取当前采样器/噪声表枚举——站点换模型后点一下即可跟上,不自动拉取、生图不发请求。
        </p>

        <div class="be-row">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">采样器</span>
            </div>
            <select class="bbi-input bbi-select" v-model="settings.latent.sampler">
              <option v-for="s in samplerOptions" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">噪声表</span>
            </div>
            <select class="bbi-input bbi-select" v-model="settings.latent.noiseSchedule">
              <option v-for="s in noiseOptions" :key="s.value" :value="s.value">
                {{ s.label }}
              </option>
            </select>
          </div>
        </div>

        <div class="be-row be-row--nums">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">步数</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.latent.steps" min="8" max="16" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">种子</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.latent.seed"
              min="0"
              placeholder="0 = 随机"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">同时出图数</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.latent.concurrency"
              min="1"
              max="4"
            />
          </div>
        </div>
        <p class="bbi-field-hint">尺寸为站点固定两档(竖 920×1536 / 横 1536×920),按 tag 判向自动选择,无输入项。</p>
      </Collapsible>
    </div>

    <!-- 绑定正/负面词编辑弹窗(与 NAI 面板的 openNaiPrompt 同款交互) -->
    <ModalMask :open="!!editingPrompt" @close="closePrompt">
      <div
        v-if="editingPrompt"
        class="bbi-modal bbi-modal-wide"
        role="dialog"
        aria-modal="true"
        :aria-label="`编辑${editingPrompt.label}`"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">
            {{ editingPrompt.readonly ? '查看' : '编辑' }}{{ editingPrompt.label }}
          </span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closePrompt">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-modal-label">{{ editingPrompt.hint }}</p>

        <BbiTextarea
          v-model="promptDraft"
          class="bbi-prompt-area"
          :rows="10"
          :max-rows="24"
          mono
          :readonly="editingPrompt.readonly"
        />

        <footer class="bbi-modal-foot">
          <template v-if="!editingPrompt.readonly">
            <button class="bbi-btn bbi-btn-danger" type="button" @click="resetPromptDraft">
              <Icon name="refresh" /> 恢复默认
            </button>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn" type="button" @click="closePrompt">取消</button>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="savePrompt">完成</button>
          </template>
          <template v-else>
            <span class="bbi-modal-foot-spacer"></span>
            <button class="bbi-btn bbi-btn-primary" type="button" @click="closePrompt">关闭</button>
          </template>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
/* 渠道级与画师串编辑区的分界(与 NaiPanel 同款虚线) */
.art-divider {
  border: 0;
  border-top: 1px dashed var(--bbi-line);
  margin: 12px 0;
}
/* 绑定正/负面词列表(与 NaiPanel 同款,scoped 需各抄一份;状态药丸在 base.css 全局) */
.bbi-prompt-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-prompt-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
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
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}
/* 「已被画师串覆盖」警示药丸(与 NaiPanel 同款;base.css 只有 is-custom,此态各页自带) */
.bbi-prompt-state.is-shadowed {
  color: var(--bbi-warning);
  background: transparent;
}
.bbi-modal-wide {
  max-width: 680px;
}
.bbi-prompt-area {
  line-height: 1.6;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  tab-size: 2;
}
.key-row {
  display: flex;
  gap: 8px;
}
.key-row .bbi-input {
  flex: 1 1 auto;
  min-width: 0;
}
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 12px;
}
.conn-use,
.conn-inuse {
  margin-right: auto;
}
.conn-inuse {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-accent);
}
/* 语义配对紧凑行(与 NaiPanel 同款,scoped 需各抄一份) */
.be-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
  margin-bottom: 18px;
}
.caps-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 6px;
}
.caps-status {
  margin-right: auto;
}
.be-row .bbi-field {
  margin-bottom: 0;
}
.be-row--nums {
  grid-template-columns: repeat(3, 1fr);
}
@media (max-width: 640px) {
  .be-row {
    grid-template-columns: 1fr;
  }
  .be-row--nums {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
