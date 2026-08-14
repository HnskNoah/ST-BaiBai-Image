<script setup lang="ts">
import Collapsible from '@/components/Collapsible.vue';
import Icon from '@/components/Icon.vue';
import { settings } from '@/state/settings';
import { computed } from 'vue';

/** 本渠道是否为当前出图渠道;「使用此渠道」按钮与设置页选择器、页签徽标同属一个开关。 */
const inUse = computed(() => settings.defaultBackend === 'nai');
</script>

<template>
  <div class="panel">
    <p class="bbi-page-intro">NovelAI 官方生图接口。地址固定,仅需 API Key。</p>

    <div class="bbi-sections">
      <Collapsible title="配置" :open="false">
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">API Key</span>
          </div>
          <input class="bbi-input" type="password" placeholder="nai-..." disabled spellcheck="false" />
          <p class="bbi-field-hint">密钥功能开发中;后续考虑复用 ST 的密钥管理,避免明文落盘</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">正面质量词</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.nai.qualityTags"
            placeholder="masterpiece, best quality, ..."
            spellcheck="false"
          />
          <p class="bbi-field-hint">生成时自动拼到正向提示词前面</p>
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">负面提示词</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.nai.negativePrompt"
            placeholder="lowres, bad anatomy, ..."
            spellcheck="false"
          />
        </div>

        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">分辨率</span>
          </div>
          <input
            class="bbi-input"
            type="text"
            v-model="settings.nai.resolution"
            placeholder="如 832×1216"
            spellcheck="false"
          />
        </div>

        <div class="conn-actions">
          <span v-if="inUse" class="conn-inuse"><Icon name="check" :size="13" /> 当前出图渠道</span>
          <button
            v-else
            class="bbi-btn conn-use"
            type="button"
            title="tag 书写规范会切到 NAI;出图功能开发中"
            @click="settings.defaultBackend = 'nai'"
          >
            使用此渠道出图
          </button>
          <button class="bbi-btn" type="button" disabled title="功能开发中">
            <Icon name="plug" />
            测试连接
          </button>
        </div>
      </Collapsible>

      <Collapsible title="默认参数" :open="false">
        <div class="be-grid">
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">模型</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>nai-diffusion-4-5-full</option>
              <option>nai-diffusion-4-full</option>
              <option>nai-diffusion-3</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">采样器</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>(跟随模型默认)</option>
            </select>
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">步数</span>
            </div>
            <input class="bbi-input" type="number" placeholder="28" disabled />
          </div>
          <div class="bbi-field">
            <div class="bbi-field-head">
              <span class="bbi-field-label">尺寸</span>
            </div>
            <select class="bbi-input bbi-select" disabled>
              <option>832 × 1216(竖)</option>
              <option>1216 × 832(横)</option>
              <option>1024 × 1024(方)</option>
            </select>
          </div>
        </div>
        <div class="bbi-field">
          <div class="bbi-field-head">
            <span class="bbi-field-label">质量标签(自动拼到正向提示词前)</span>
          </div>
          <input class="bbi-input" type="text" placeholder="masterpiece, best quality, ..." disabled />
          <p class="bbi-field-hint">参数功能开发中,当前仅展示</p>
        </div>
      </Collapsible>
    </div>
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
.conn-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
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
