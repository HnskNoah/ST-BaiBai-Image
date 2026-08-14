<script setup lang="ts">
import { getWorkflowPlaceholders, testComfyConnection } from '@/backends/comfyui';
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { settings } from '@/state/settings';
import { computed, ref } from 'vue';

const testing = ref(false);

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'comfyui');

const workflowState = computed(() => {
  if (!settings.comfyui.workflow.trim()) return { tone: 'muted', text: '尚未填写工作流。' };
  try {
    const placeholders = getWorkflowPlaceholders(settings.comfyui.workflow);
    if (!placeholders.includes('prompt')) {
      return { tone: 'error', text: 'JSON 有效，但缺少必需的 %prompt% 占位符。' };
    }
    const unknown = placeholders.filter(name => !['prompt', 'negative_prompt', 'seed', 'nl'].includes(name));
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
        <textarea
            v-model="settings.comfyui.workflow"
            v-autosize
            class="bbi-input be-mono workflow-input"
            rows="10"
            placeholder='{"3": {"class_type": "KSampler", ...}, ...}'
            spellcheck="false"
          ></textarea>
          <p class="bbi-field-hint">
            在 ComfyUI 中使用「Save (API Format)」导出。将正向提示词改为 %prompt%，可选使用
            %negative_prompt%、%seed% 和 %nl%(自然语言部分,不会自动拼进 %prompt%)。
          </p>
          <p class="workflow-state" :class="`is-${workflowState.tone}`">{{ workflowState.text }}</p>
      </Collapsible>
    </div>
  </div>
</template>

<style scoped>
.be-mono {
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
}
.workflow-input {
  min-height: 180px;
  max-height: 420px;
  resize: vertical;
}
.workflow-state {
  margin: 10px 0 0;
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
  color: #c44747;
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
</style>
