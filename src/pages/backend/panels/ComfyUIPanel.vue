<script setup lang="ts">
import { getWorkflowPlaceholders, testComfyConnection } from '@/backends/comfyui';
import {
  configureWorkflowWithAi,
  type WorkflowAssistResult,
  type WorkflowBindingPurpose,
} from '@/backends/comfyWorkflowAssistant';
import BbiTextarea from '@/components/BbiTextarea.vue';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { settings } from '@/state/settings';
import { computed, ref } from 'vue';

const testing = ref(false);
const configuring = ref(false);
const assistOpen = ref(false);
const assistDraft = ref('');
const assistResult = ref<WorkflowAssistResult | null>(null);

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'comfyui');

const workflowState = computed(() => {
  if (!settings.comfyui.workflow.trim()) return { tone: 'muted', text: '尚未填写工作流。' };
  try {
    const placeholders = getWorkflowPlaceholders(settings.comfyui.workflow);
    if (!placeholders.includes('prompt')) {
      return { tone: 'error', text: 'JSON 有效，但缺少必需的 %prompt% 占位符。' };
    }
    const unknown = placeholders.filter(
      name => !['prompt', 'negative_prompt', 'seed', 'nl', 'width', 'height'].includes(name),
    );
    if (unknown.length) {
      return { tone: 'error', text: `暂不支持：${unknown.map(name => `%${name}%`).join('、')}` };
    }
    return {
      tone: 'ok',
      text: `工作流有效；已识别 ${placeholders.map(name => `%${name}%`).join('、')}。`,
    };
  } catch (error) {
    return { tone: 'error', text: errorMessage(error) };
  }
});

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '操作已取消';
  return error instanceof Error ? error.message : String(error);
}

async function onTestConnection() {
  if (testing.value) return;
  testing.value = true;
  try {
    const result = await testComfyConnection(settings.comfyui);
    toastr.success(result.mode === 'server' ? 'ComfyUI 连接正常（ST 后端转发）' : 'ComfyUI 连接正常（浏览器直连）');
  } catch (error) {
    toastr.error(errorMessage(error), 'ComfyUI 连接失败');
  } finally {
    testing.value = false;
  }
}

const purposeLabels: Record<WorkflowBindingPurpose, string> = {
  positive_tag: '正向 tag',
  positive_nl: '独立自然语言',
  positive_combined: '正向 tag + 自然语言共用',
  negative: '负面提示词',
  seed: '随机种子',
  width: '主画布宽度',
  height: '主画布高度',
};

async function onAutoConfigure() {
  if (configuring.value || !settings.comfyui.workflow.trim()) return;
  configuring.value = true;
  try {
    const result = await configureWorkflowWithAi(settings.comfyui.workflow);
    if (!result.changes.length) {
      toastr.info('工作流中的动态参数已经配置，无需修改', '柏宝绘');
      return;
    }
    assistResult.value = result;
    assistDraft.value = result.workflow;
    assistOpen.value = true;
  } catch (error) {
    toastr.error(errorMessage(error), 'AI 配置工作流失败');
  } finally {
    configuring.value = false;
  }
}

function closeAssist() {
  assistOpen.value = false;
  assistResult.value = null;
  assistDraft.value = '';
}

function applyAssist() {
  try {
    const placeholders = getWorkflowPlaceholders(assistDraft.value);
    if (!placeholders.includes('prompt')) throw new Error('预览工作流缺少 %prompt% 占位符');
    settings.comfyui.workflow = assistDraft.value;
    closeAssist();
    toastr.success('已应用 AI 配置的工作流', '柏宝绘');
    if (placeholders.includes('nl') && !settings.comfyui.naturalLanguage) {
      toastr.info('工作流已配置 %nl%；需要时请开启「生成自然语言」', '柏宝绘');
    }
  } catch (error) {
    toastr.error(errorMessage(error), '工作流无法应用');
  }
}
</script>

<template>
  <div class="panel">
    <div class="bbi-sections">
      <Collapsible title="配置" :open="false">
        <div class="api-row">
          <span class="bbi-field-label">URL</span>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.comfyui.url"
            placeholder="http://127.0.0.1:8188"
            spellcheck="false"
          />
        </div>

        <label class="bbi-switch-row">
          <span class="bbi-field-label">生成自然语言</span>
          <input v-model="settings.comfyui.naturalLanguage" type="checkbox" class="bbi-checkbox" />
        </label>

        <div class="size-grid">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">竖屏尺寸(宽×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.comfyui.portraitSize"
              placeholder="832×1216"
              spellcheck="false"
            />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">横屏尺寸(宽×高)</span>
            </div>
            <input
              class="bbi-input"
              type="text"
              v-model="settings.comfyui.landscapeSize"
              placeholder="1216×832"
              spellcheck="false"
            />
          </div>
        </div>
        <p class="bbi-field-hint">
          自动 tag 会为每个画面判定横屏还是竖屏(群像/远景→横，单人/特写→竖)，出图时取对应尺寸。
          仅在工作流用了 %width% / %height% 时生效；不改工作流则沿用工作流里写死的尺寸。
        </p>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            @click="settings.defaultBackend = 'comfyui'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" :disabled="testing" @click="onTestConnection">
            <Icon name="plug" />
            {{ testing ? '连接中…' : '测试连接' }}
          </button>
        </div>
      </Collapsible>

      <Collapsible title="工作流" :open="false">
        <BbiTextarea
          v-model="settings.comfyui.workflow"
          :rows="8"
          :max-rows="24"
          mono
          placeholder='{"3": {"class_type": "KSampler", ...}, ...}'
        />
        <p class="bbi-field-hint">
          在 ComfyUI 中使用「Save (API Format)」导出。可手动使用 %prompt%、%negative_prompt%、
          %seed%、%nl%、%width% / %height%，也可让 AI 判断节点后自动配置。
          AI会从原正负提示词中提取质量词、模型触发词和固定风格，移除导出时的示例角色与场景。
        </p>
        <div class="workflow-actions">
          <p class="workflow-state" :class="`is-${workflowState.tone}`">{{ workflowState.text }}</p>
          <button
            class="bbi-btn bbi-btn-primary"
            type="button"
            :disabled="configuring || !settings.comfyui.workflow.trim()"
            @click="onAutoConfigure"
          >
            <Icon name="sparkles" />
            {{ configuring ? '分析中…' : 'AI 自动配置' }}
          </button>
        </div>
        <p class="bbi-field-hint workflow-ai-hint">
          使用设置页「生成 tag 使用」的 API；工作流节点、模型名和本地路径会发送给该 API。
        </p>
      </Collapsible>
    </div>

    <ModalMask :open="assistOpen" @close="closeAssist">
      <div
        v-if="assistResult"
        class="bbi-modal workflow-assist-modal"
        role="dialog"
        aria-modal="true"
        aria-label="预览 AI 配置的工作流"
      >
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">预览工作流修改</span>
          <button class="bbi-icon-btn" type="button" aria-label="关闭" @click="closeAssist">
            <Icon name="close" />
          </button>
        </header>

        <p class="bbi-field-hint">
          AI只返回节点用途和需要保留的片段编号，原文与宏均由插件本地重建。请检查预览后再应用。
        </p>
        <div class="workflow-change-list">
          <div
            v-for="change in assistResult.changes"
            :key="`${change.node}:${change.input}`"
            class="workflow-change"
          >
            <span class="workflow-change-role">{{ purposeLabels[change.purpose] }}</span>
            <code>{{ change.node }}.inputs.{{ change.input }}</code>
          </div>
        </div>

        <BbiTextarea v-model="assistDraft" :rows="10" :max-rows="24" mono />

        <p v-if="assistResult.nlMode !== 'none'" class="workflow-detection">
          自然语言：{{ assistResult.nlMode === 'combined' ? '与正向 tag 共用输入' : '使用独立输入' }}
        </p>
        <p v-if="assistResult.hasNegative" class="workflow-detection">
          已配置动态负面词；生成 tag 时会按画面输出补充负面 tag。
        </p>

        <footer class="bbi-modal-foot">
          <span class="bbi-modal-foot-spacer"></span>
          <button class="bbi-btn" type="button" @click="closeAssist">取消</button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="applyAssist">
            <Icon name="check" />
            应用工作流
          </button>
        </footer>
      </div>
    </ModalMask>
  </div>
</template>

<style scoped>
.be-mono {
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
}
.workflow-state {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
}
.workflow-state.is-muted {
  color: var(--bbi-ink-muted);
}
.workflow-state.is-ok {
  color: var(--bbi-accent);
}
.workflow-state.is-error {
  color: var(--bbi-danger);
}
.workflow-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.workflow-ai-hint {
  margin-top: 8px;
}
.workflow-assist-modal {
  width: min(720px, calc(100vw - 32px));
}
.workflow-change-list {
  display: grid;
  gap: 6px;
  margin: 12px 0;
}
.workflow-change {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 9px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-size: 12px;
}
.workflow-change-role {
  flex: 0 0 118px;
  color: var(--bbi-ink);
  font-weight: 600;
}
.workflow-change code {
  min-width: 0;
  overflow-wrap: anywhere;
  color: var(--bbi-accent);
  font-family: var(--bbi-font-mono);
}
.workflow-detection {
  margin: 9px 0 0;
  color: var(--bbi-ink-soft);
  font-size: 12px;
  line-height: 1.5;
}
/* 竖屏/横屏尺寸并排;窄屏自动落成一列 */
.size-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin-top: 8px;
}
/* URL 标签与输入框同行:标签靠左不压缩,输入框吃满剩余宽度 */
.api-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.api-row .bbi-field-label {
  flex: 0 0 auto;
}
.api-row .bbi-input {
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
@media (max-width: 640px) {
  .workflow-actions {
    align-items: stretch;
    flex-direction: column;
  }
  .workflow-actions .bbi-btn {
    justify-content: center;
  }
  .workflow-change {
    align-items: flex-start;
    flex-direction: column;
    gap: 3px;
  }
  .workflow-change-role {
    flex-basis: auto;
  }
}
</style>
