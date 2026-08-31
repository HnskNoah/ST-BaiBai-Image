<script setup lang="ts">
import { computed, ref } from 'vue';
import Collapsible from '@/components/Collapsible.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Icon from '@/components/Icon.vue';
import { activeNaiArtist, LATENT_SAMPLERS, LATENT_SCHEDULERS, settings } from '@/state/settings';
import {
  BUILTIN_NAI_ARTISTS,
  isBuiltinNaiArtist,
  testNaiConnection,
} from '@/backends/nai';

/**
 * Latent 渠道:第三方站点 NovelAI 兼容面的精简适配。
 * 生成完全复用 NAI 机器(latentAsNai 映射后走 generateNaiImage),面板只暴露
 * 站点 openapi 真实存在的参数:无模型下拉(单模型站点,GenerationRequest 无 model 字段)、
 * 无 Scale(无 CFG 字段)、无尺寸输入(resolution 是枚举,按 tag 判向发 portrait/landscape)、
 * 无 Vibe、无 rescale/variety。画师串库与 NAI 渠道共用同一份(settings.nai.artistPresets)。
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
    const result = await testNaiConnection(settings.latent);
    toastr.success(result.message, 'Latent 连接');
  } catch (error) {
    toastr.error(errorMessage(error), 'Latent 连接失败');
  } finally {
    testing.value = false;
  }
}

/* —— 画师串(与 NAI 渠道共用同一份库与激活项;内置只读) —— */
const artist = computed(() => activeNaiArtist());
const NO_ARTIST = '';
const artistOptions = computed(() => [
  { value: NO_ARTIST, label: '不使用' },
  ...BUILTIN_NAI_ARTISTS.map(a => ({ value: a.id, label: `${a.name}(内置)` })),
  ...settings.nai.artistPresets.map(a => ({ value: a.id, label: a.name || '未命名画师串' })),
]);
const activeArtistId = computed<string>({
  get: () => artist.value?.id ?? NO_ARTIST,
  set: id => (settings.nai.activeArtistId = id),
});
const isBuiltin = computed(() => (artist.value ? isBuiltinNaiArtist(artist.value.id) : false));

/** 站点原生枚举(openapi 逐字一致),select 下拉;无自由输入——站点只认枚举值,填别的也是白填。 */
const samplerOptions = computed(() => LATENT_SAMPLERS.map(s => ({ value: s, label: s })));
const noiseOptions = computed(() => LATENT_SCHEDULERS.map(s => ({ value: s, label: s })));
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
        <!-- 画师串与 NAI 渠道共用同一份库与激活项;跨渠道切换即全局切换 -->
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">画师串(与 NAI 渠道共用)</span>
          </div>
          <select class="bbi-input bbi-select" v-model="activeArtistId">
            <option v-for="o in artistOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
        </div>
        <BbiTextarea
          v-if="artist"
          v-model="artist.prompt"
          :rows="3"
          :max-rows="8"
          mono
          :readonly="isBuiltin"
          placeholder="artist:xxx, artist:yyy"
        />
        <p v-if="artist && isBuiltin" class="bbi-field-hint">
          内置画师串随插件版本更新,不可直接改;在 NAI 渠道页复制一条自己的再改。
        </p>
        <p class="bbi-field-hint">新增/改名/删除画师串请到 NAI 渠道页的画师串库管理。</p>

        <hr class="bbi-rule" />

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">正面质量词(可留空)</span>
          </div>
          <BbiTextarea v-model="settings.latent.qualityTags" :rows="2" :max-rows="6" mono />
          <p class="bbi-field-hint">留空自动带 NAI 官方质量词(与 NAI 渠道同口径)。</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">负面提示词(可留空)</span>
          </div>
          <BbiTextarea v-model="settings.latent.negativePrompt" :rows="2" :max-rows="6" mono />
          <p class="bbi-field-hint">留空自动带 NAI 官方负面基线;画面级负面在楼层 tag 里,会与本条合并。</p>
        </div>
      </Collapsible>

      <Collapsible title="默认参数" :open="false">

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
  </div>
</template>

<style scoped>
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
