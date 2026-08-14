<script setup lang="ts">
import { BACKENDS, settings, type BackendId } from '@/state/settings';
import { computed, ref, type Component } from 'vue';
import ComfyUIPanel from './panels/ComfyUIPanel.vue';
import NaiPanel from './panels/NaiPanel.vue';
import WebUIPanel from './panels/WebUIPanel.vue';

// 渠道页:页签只负责「看哪个面板」(纯浏览,本地状态,初始跟随当前出图渠道)。
// 真正的选择在各面板的「使用此渠道出图」按钮(选中后显示「当前出图渠道」)
// 与设置页「出图后端」下拉,两处都读写 settings.defaultBackend,任一处改动自动跟随。
// webui 暂不开放:入口藏掉(代码保留,便于后续恢复);merge 已把存量 webui 值迁移走,这里恒有匹配页签。
const VISIBLE_BACKENDS = BACKENDS.filter(b => b.value !== 'webui');
const viewing = ref<BackendId>(
  VISIBLE_BACKENDS.some(b => b.value === settings.defaultBackend)
    ? settings.defaultBackend
    : VISIBLE_BACKENDS[0].value,
);

const PANELS: Record<BackendId, Component> = {
  webui: WebUIPanel,
  comfyui: ComfyUIPanel,
  nai: NaiPanel,
};
const activePanel = computed(() => PANELS[viewing.value]);
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">渠道</h2>
      <div class="bbi-segmented" role="tablist" aria-label="生图渠道">
        <button
          v-for="b in VISIBLE_BACKENDS"
          :key="b.value"
          class="bbi-seg"
          :class="{ 'is-on': viewing === b.value }"
          type="button"
          role="tab"
          :aria-selected="viewing === b.value"
          @click="viewing = b.value"
        >
          {{ b.label }}
        </button>
      </div>
    </div>
    <hr class="bbi-rule" />

    <!-- KeepAlive:切换渠道时保留各面板的折叠/输入状态 -->
    <KeepAlive>
      <component :is="activePanel" :key="viewing" />
    </KeepAlive>
  </section>
</template>

<style scoped>
/* 窄屏下标题与渠道分段控件分两行,不挤压 */
.bbi-page-head {
  flex-wrap: wrap;
}
</style>
