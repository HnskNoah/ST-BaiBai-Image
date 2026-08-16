<script setup lang="ts">
import {
  CHATU8_SETTINGS_KEY,
  detectChatu8Vibes,
  importVibesFromChatu8,
  type Chatu8DetectInfo,
} from '@/backends/chatu8Vibe';
import {
  buildNaiv4vibe,
  encodeVibeImage,
  NAI_NOISE_SCHEDULES,
  NAI_SAMPLERS,
  parseNaiv4vibe,
  testNaiConnection,
  ucPresetNames,
  vibeModelKey,
} from '@/backends/nai';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { getContext } from '@/st/context';
import { NAI_MODELS, settings, type NaiVibe } from '@/state/settings';
import { computed, onMounted, ref, watch } from 'vue';

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'nai');

const testing = ref(false);
const showKey = ref(false);

/** 负面预设选项跟随模型;切换模型后原预设不存在时回落 Heavy。 */
const ucOptions = computed(() => ucPresetNames(settings.nai.model));
watch(
  () => settings.nai.model,
  () => {
    if (!ucOptions.value.includes(settings.nai.ucPreset)) {
      settings.nai.ucPreset = ucOptions.value.includes('Heavy') ? 'Heavy' : '无';
    }
  },
);

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testNaiConnection(settings.nai);
    toastr.success(result.message, 'NAI 连接');
  } catch (error) {
    toastr.error(errorMessage(error), 'NAI 连接失败');
  } finally {
    testing.value = false;
  }
}

/* ============ Vibe 库 ============ */

const vibeEncoding = ref(false);
const vibeFileInput = ref<HTMLInputElement | null>(null);
const vibeImportInput = ref<HTMLInputElement | null>(null);

let vibeSeq = 0;

/** 当前模型的 vibe 编码 key;vibe 缺此 key 时生成会被跳过,列表里给「补编码」入口。 */
const currentVibeKey = computed(() => vibeModelKey(settings.nai.model));

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片加载失败'));
    img.src = src;
  });
}

/** 生成 vibe 列表缩略图(最长边 96px 的 jpeg dataURL)。 */
async function makeThumbnail(dataUrl: string): Promise<string> {
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, 96 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return '';
  }
}

/** 上传参考图 → 调 /ai/encode-vibe 编码(按当前模型)→ 入库。 */
async function onVibeFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('读取图片失败'));
      reader.readAsDataURL(file);
    });
    const imageBase64 = dataUrl.split(',')[1] ?? '';
    const encoding = await encodeVibeImage(settings.nai, imageBase64, settings.nai.model);
    const thumbnail = await makeThumbnail(dataUrl);
    settings.nai.vibes.push({
      id: `vibe_${Date.now()}_${++vibeSeq}`,
      name: file.name.replace(/\.[^.]+$/, '') || `Vibe ${settings.nai.vibes.length + 1}`,
      image: imageBase64,
      thumbnail,
      encodings: { [currentVibeKey.value]: { encoding, infoExtracted: 1 } },
      strength: 0.6,
      enabled: true,
    });
    toastr.success(`已按 ${settings.nai.model} 编码并加入 Vibe 库`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 编码失败');
  } finally {
    vibeEncoding.value = false;
  }
}

/**  vibe 缺当前模型编码时单独补(切换模型后常见)。 */
async function reencodeVibe(vibe: NaiVibe) {
  if (!vibe.image || vibeEncoding.value) return;
  vibeEncoding.value = true;
  try {
    const encoding = await encodeVibeImage(settings.nai, vibe.image, settings.nai.model);
    vibe.encodings[currentVibeKey.value] = { encoding, infoExtracted: 1 };
    toastr.success(`「${vibe.name}」已补 ${settings.nai.model} 编码`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 编码失败');
  } finally {
    vibeEncoding.value = false;
  }
}

/* ============ 从智绘姬迁移 ============ */

/**
 * 智绘姬 vibe 检测:面板挂载时做一次(读的是 settings 里的引用列表,同步廉价)。
 * 不做「只问一次」那套:区块常驻,迁移幂等(内容指纹去重),用户随时可以再来。
 */
const chatu8Detect = ref<Chatu8DetectInfo>({ found: false, total: 0, presets: 0, groups: 0 });
onMounted(() => {
  chatu8Detect.value = detectChatu8Vibes(getContext()?.extensionSettings?.[CHATU8_SETTINGS_KEY]);
});

const migrateConfirmOpen = ref(false);
const migrating = ref(false);
const migrateMsg = ref('');

async function runMigrate() {
  migrateConfirmOpen.value = false;
  if (migrating.value) return;
  migrating.value = true;
  migrateMsg.value = '';
  try {
    const result = await importVibesFromChatu8(settings.nai.vibes);
    settings.nai.vibes.push(...result.vibes);
    const parts = [`新增 ${result.imported} 个`];
    if (result.duplicates) parts.push(`重复跳过 ${result.duplicates}`);
    if (result.failed) parts.push(`读不到 ${result.failed}`);
    migrateMsg.value = `迁移完成：${parts.join(' / ')}。`;
    if (result.failed) migrateMsg.value += '读不到的多半存在其他设备的浏览器本地存储里。';
    toastr.success(migrateMsg.value, '从智绘姬迁移');
  } catch (error) {
    migrateMsg.value = `迁移失败：${errorMessage(error)}`;
  } finally {
    migrating.value = false;
  }
}

async function onVibeImportChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = parseNaiv4vibe(await file.text());
    settings.nai.vibes.push({
      id: `vibe_${Date.now()}_${++vibeSeq}`,
      name: parsed.name,
      image: parsed.image,
      thumbnail: parsed.thumbnail,
      encodings: parsed.encodings,
      strength: parsed.strength,
      enabled: true,
    });
    toastr.success(`已导入「${parsed.name}」`, 'Vibe');
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 导入失败');
  }
}

async function exportVibe(vibe: NaiVibe) {
  try {
    const json = await buildNaiv4vibe(vibe);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${vibe.name || 'vibe'}.naiv4vibe`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    toastr.error(errorMessage(error), 'Vibe 导出失败');
  }
}

function removeVibe(vibe: NaiVibe) {
  const index = settings.nai.vibes.indexOf(vibe);
  if (index >= 0) settings.nai.vibes.splice(index, 1);
}
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">
      NovelAI 生图接口。地址默认为官方,填第三方兼容站(镜像/转发)即走第三方,协议一致。
    </p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="true">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">接口地址</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.nai.url"
            placeholder="https://image.novelai.net"
            spellcheck="false"
          />
          <p class="bbi-field-hint">默认官方;第三方站填域名即可(自动补 /ai 端点),也可直接填完整端点 URL</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <div class="key-row">
            <input
              class="bbi-input"
              :type="showKey ? 'text' : 'password'"
              v-model="settings.nai.key"
              placeholder="nai-..."
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
          <p class="bbi-field-hint">官方站在 NovelAI 设置页生成;与副 API 渠道同口径,随设置跨设备同步</p>
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag 书写规范会切到 NAI"
            @click="settings.defaultBackend = 'nai'"
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
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">正面质量词</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.nai.qualityTags"
            placeholder="留空则按模型用内置质量词"
            spellcheck="false"
          />
          <p class="bbi-field-hint">生成时拼到正向提示词最前;留空 + 质量词开关开启时按模型自动附加</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">负面提示词</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.nai.negativePrompt"
            placeholder="bad anatomy, bad hands, ..."
            spellcheck="false"
          />
          <p class="bbi-field-hint">与下方负面预设一起拼进负面</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">负面预设</span>
          </div>
          <select class="bbi-input bbi-select" v-model="settings.nai.ucPreset">
            <option v-for="name in ucOptions" :key="name" :value="name">{{ name }}</option>
          </select>
          <p class="bbi-field-hint">各模型内置的官方负面词组,选项跟随当前模型</p>
        </div>
      </Collapsible>

      <Collapsible title="默认参数" :open="false">
        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">模型</span>
            </div>
            <select class="bbi-input bbi-select" v-model="settings.nai.model">
              <option v-for="m in NAI_MODELS" :key="m.value" :value="m.value">{{ m.label }}</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">竖屏尺寸(宽×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.portraitSize"
              list="nai-portrait-presets"
              placeholder="832×1216"
              spellcheck="false"
            />
            <datalist id="nai-portrait-presets">
              <option value="832×1216">竖版</option>
              <option value="1024×1536">大竖版</option>
              <option value="1024×1024">方图</option>
            </datalist>
            <p class="bbi-field-hint">单人、特写、立绘等画面用此尺寸</p>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">横屏尺寸(宽×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.nai.landscapeSize"
              list="nai-landscape-presets"
              placeholder="1216×832"
              spellcheck="false"
            />
            <datalist id="nai-landscape-presets">
              <option value="1216×832">横版</option>
              <option value="1536×1024">大横版</option>
              <option value="1024×1024">方图</option>
            </datalist>
            <p class="bbi-field-hint">群像、远景、全景等画面用此尺寸；由自动 tag 判定方向</p>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">采样器</span>
            </div>
            <select class="bbi-input bbi-select" v-model="settings.nai.sampler">
              <option v-for="s in NAI_SAMPLERS" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">噪声表</span>
            </div>
            <select class="bbi-input bbi-select" v-model="settings.nai.noiseSchedule">
              <option v-for="s in NAI_NOISE_SCHEDULES" :key="s.value" :value="s.value">
                {{ s.label }}
              </option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">步数</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.steps" min="1" max="50" />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">提示词相关性(Scale)</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.scale"
              min="0"
              max="35"
              step="0.1"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">相关性调整(Rescale)</span>
            </div>
            <input
              class="bbi-input"
              type="number"
              v-model.number="settings.nai.cfgRescale"
              min="0"
              max="1"
              step="0.05"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">种子(0 = 随机)</span>
            </div>
            <input class="bbi-input" type="number" v-model.number="settings.nai.seed" min="0" />
          </div>
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">质量词开关(无自定义质量词时按模型附加内置质量词)</span>
          <input v-model="settings.nai.qualityToggle" type="checkbox" class="bbi-checkbox" />
        </label>
        <label class="bbi-switch-row">
          <span class="bbi-field-label">Variety Boost(画面多样性,按尺寸自动计算)</span>
          <input v-model="settings.nai.varietyBoost" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="bbi-num-row">
          <span class="bbi-field-label">同时出图数</span>
          <input
            class="bbi-input bbi-num"
            type="number"
            v-model.number="settings.nai.concurrency"
            min="1"
            max="4"
          />
        </div>
        <p class="bbi-field-hint">
          一层多张图时同时发起几个请求。NAI 服务端不排队,并发太高容易被限流(429),
          建议保持 1;超出的请求会自动排队等待。(ComfyUI 有服务端队列,无需此设置)
        </p>
      </Collapsible>

      <Collapsible title="Vibe 库(氛围转移)" :open="false">
        <p class="bbi-field-hint vibe-hint">
          上传参考图编码为 vibe,生成时叠加其风格/氛围。NAI3 直接发参考原图;NAI4/4.5
          需先编码(会消耗一次接口调用),编码按当前选中的模型生成。支持导入/导出官方 .naiv4vibe 文件。
        </p>

        <div class="vibe-actions">
          <button class="bbi-btn" type="button" :disabled="vibeEncoding" @click="vibeFileInput?.click()">
            <Icon name="plus" />
            {{ vibeEncoding ? '编码中…' : '上传图片编码' }}
          </button>
          <button class="bbi-btn" type="button" @click="vibeImportInput?.click()">
            <Icon name="download" />
            导入 .naiv4vibe
          </button>
          <label class="bbi-switch-row vibe-normalize">
            <span class="bbi-field-label">强度归一化</span>
            <input v-model="settings.nai.normalizeRefStrength" type="checkbox" class="bbi-checkbox" />
          </label>
          <input ref="vibeFileInput" type="file" accept="image/*" hidden @change="onVibeFileChange" />
          <input ref="vibeImportInput" type="file" accept=".naiv4vibe" hidden @change="onVibeImportChange" />
        </div>

        <p v-if="!settings.nai.vibes.length" class="bbi-field-hint">还没有 vibe;上传一张参考图开始。</p>

        <div v-for="vibe in settings.nai.vibes" :key="vibe.id" class="vibe-item">
          <img v-if="vibe.thumbnail" class="vibe-thumb" :src="vibe.thumbnail" :alt="vibe.name" />
          <div v-else class="vibe-thumb vibe-thumb--empty"><Icon name="generate" /></div>
          <div class="vibe-main">
            <div class="vibe-head">
              <input class="bbi-input vibe-name" type="text" v-model="vibe.name" spellcheck="false" />
              <label class="vibe-enable" title="生成时叠加此 vibe">
                <input v-model="vibe.enabled" type="checkbox" class="bbi-checkbox" />
                启用
              </label>
            </div>
            <div class="vibe-strength">
              <span class="vibe-strength-label">强度 {{ vibe.strength.toFixed(2) }}</span>
              <input type="range" min="0" max="1" step="0.05" v-model.number="vibe.strength" />
            </div>
            <div class="vibe-ops">
              <button
                v-if="!vibe.encodings[currentVibeKey] && vibe.image"
                class="bbi-btn bbi-btn--mini"
                type="button"
                :disabled="vibeEncoding"
                title="该 vibe 缺当前模型的编码,生成时会被跳过;点击按当前模型补编码"
                @click="reencodeVibe(vibe)"
              >
                <Icon name="refresh" :size="12" /> 补当前模型编码
              </button>
              <span v-else-if="!vibe.encodings[currentVibeKey]" class="vibe-missing">
                缺当前模型编码且无原图,无法使用
              </span>
              <button class="bbi-btn bbi-btn--mini" type="button" title="导出 .naiv4vibe" @click="exportVibe(vibe)">
                <Icon name="upload" :size="12" /> 导出
              </button>
              <button class="bbi-btn bbi-btn--mini" type="button" title="删除" @click="removeVibe(vibe)">
                <Icon name="trash" :size="12" /> 删除
              </button>
            </div>
          </div>
        </div>
      </Collapsible>

      <Collapsible title="从智绘姬迁移" :open="false">
        <p class="bbi-field-hint vibe-hint">
          把智绘姬(st-chatu8)里的 vibe 复制一份到柏宝绘 Vibe 库。只是创建副本，不会改动智绘姬的数据；
          内容相同的会自动跳过，可以反复迁移。
        </p>
        <p class="bbi-field-hint">
          <template v-if="!chatu8Detect.found">未检测到智绘姬（插件未安装或未启用）。</template>
          <template v-else-if="!chatu8Detect.total">智绘姬里没有找到 vibe。</template>
          <template v-else>
            检测到智绘姬有 {{ chatu8Detect.total }} 个 vibe（预设 {{ chatu8Detect.presets }} 个 / 组内
            {{ chatu8Detect.groups }} 个）。
          </template>
        </p>
        <div class="migrate-actions">
          <button
            class="bbi-btn"
            type="button"
            :disabled="migrating || !chatu8Detect.total"
            @click="migrateConfirmOpen = true"
          >
            <Icon name="download" />
            {{ migrating ? '迁移中…' : '迁移智绘姬的 vibe' }}
          </button>
        </div>
        <p v-if="migrateMsg" class="bbi-field-hint">{{ migrateMsg }}</p>
      </Collapsible>
    </div>

    <ModalMask :open="migrateConfirmOpen" @close="migrateConfirmOpen = false">
      <div class="bbi-modal" role="dialog" aria-modal="true" aria-label="从智绘姬迁移">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">从智绘姬迁移 vibe</span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="migrateConfirmOpen = false">
            <Icon name="close" />
          </button>
        </header>
        <p class="bbi-modal-label">
          将把智绘姬的 {{ chatu8Detect.total }} 个 vibe 复制到柏宝绘 Vibe
          库，只是创建副本，不会改动智绘姬的数据。内容相同的会自动跳过，重复迁移不会产生重复条目。
        </p>
        <p class="bbi-modal-label">
          注意：智绘姬未开「酒馆储存」时 vibe 存在浏览器本地存储里，只有本设备本浏览器读得到。
        </p>
        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="migrateConfirmOpen = false">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="runMigrate">开始迁移</button>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
.be-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0 12px;
}
@media (max-width: 640px) {
  .be-grid {
    grid-template-columns: 1fr;
  }
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
/* 左侧「使用此渠道 / 当前出图渠道」与右侧测试连接分据两端 */
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
.vibe-hint {
  margin-top: 0;
}
.migrate-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.vibe-normalize {
  margin-left: auto;
}
.vibe-item {
  display: flex;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--bbi-border, rgba(127, 127, 127, 0.2));
}
.vibe-thumb {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  flex: 0 0 auto;
}
.vibe-thumb--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(127, 127, 127, 0.12);
  color: var(--bbi-ink-muted);
}
.vibe-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.vibe-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-name {
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 8px;
  font-size: 13px;
}
.vibe-enable {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength {
  display: flex;
  align-items: center;
  gap: 8px;
}
.vibe-strength-label {
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
}
.vibe-strength input[type='range'] {
  flex: 1 1 auto;
  min-width: 0;
}
.vibe-ops {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vibe-missing {
  font-size: 12px;
  color: #c44747;
}
</style>
