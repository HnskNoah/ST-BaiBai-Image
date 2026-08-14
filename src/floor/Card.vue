<script setup lang="ts">
import { computed, ref } from 'vue';

import { generateComfyImage, randomSeed } from '@/backends/comfyui';
import { hydrateMessage } from '@/floor/hydrate';
import { saveImageResult, type BbiImageEntry } from '@/floor/storage';
import { settings } from '@/state/settings';
import { getContext } from '@/st/context';

/**
 * 楼层生图卡片（DESIGN-FLOOR-UI.md §8）。
 * 形态：pending / generating / ready / stale / error；ready 时在同一提示词的
 * 历史结果间翻页（◀ 2/5 ▶）。结果落盘到 message.extra（storage.ts），
 * 水合时按 (promptHash, slotSeq) 恢复；组件被重水合时从 extra 重建，持久化不丢。
 */

const props = defineProps<{
  /** tag 原文解析出的 tag 部分（danbooru 短 tag；展示与生成用）。 */
  prompt: string;
  /** tag 原文解析出的自然语言部分（无则空串；生成时写入 %nl% 占位符）。 */
  nl: string;
  /** tag 原文（含 <bbi_image> 壳）：生成提交与 promptHash 的输入。 */
  tag: string;
  messageId: number;
  seq: number;
  swipeId: number;
  /** 当前提示词同槽位的全部历史（时间正序，最新在末尾）。 */
  history: BbiImageEntry[];
  /** 无匹配历史时，旧提示词同槽位的最新结果（stale）。 */
  staleEntry: BbiImageEntry | null;
}>();

type Phase = 'pending' | 'generating' | 'ready' | 'stale' | 'error';
const phase = ref<Phase>(
  props.history.length ? 'ready' : props.staleEntry ? 'stale' : 'pending',
);
/** 当前翻页位置，默认最新一张。 */
const index = ref(props.history.length ? props.history.length - 1 : 0);
const error = ref('');
const promptOpen = ref(false);

let controller: AbortController | null = null;

/** 出图后端是否为 ComfyUI(当前唯一实现的出图后端;选 NAI 时生成禁用)。 */
const comfyActive = computed(() => settings.defaultBackend === 'comfyui');
const configured = computed(
  () => comfyActive.value && !!settings.comfyui.url.trim() && !!settings.comfyui.workflow.trim(),
);

const current = computed(() => props.history[index.value] ?? null);
const imageSrc = computed(() =>
  phase.value === 'ready'
    ? (current.value?.path ?? '')
    : phase.value === 'stale'
      ? (props.staleEntry?.path ?? '')
      : '',
);

async function generate(): Promise<void> {
  if (phase.value === 'generating' || !configured.value) return;
  error.value = '';
  controller = new AbortController();
  phase.value = 'generating';
  try {
    // 发起时就生成随机种子并显式传入（不支持 -1 自动随机的节点也安全），
    // 随结果落盘进 extra（entry.seed），历史翻页可查/可复用。
    const seed = randomSeed();
    const result = await generateComfyImage(
      settings.comfyui,
      { prompt: props.prompt, nl: props.nl, seed },
      controller.signal,
    );
    // 落盘：图片进 ST 文件系统 + extra 写指针。成功后重水合，
    // 卡片从 extra 恢复为 ready（blob/dataURL 生命周期随之结束）。
    await saveImageResult(props.messageId, props.swipeId, props.seq, props.tag, seed, result);
    result.revoke();
    const ctx = getContext();
    if (ctx) hydrateMessage(props.messageId, ctx);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      phase.value = props.history.length ? 'ready' : props.staleEntry ? 'stale' : 'pending';
    } else {
      error.value = e instanceof Error ? e.message : String(e);
      phase.value = 'error';
    }
  } finally {
    controller = null;
  }
}

function cancel(): void {
  controller?.abort();
}
</script>

<template>
  <div class="bbi-card" :data-phase="phase">
    <div class="bbi-card__head">
      <span class="bbi-card__title">柏宝绘</span>
      <span v-if="phase === 'stale'" class="bbi-card__stale-tag">已过时</span>
      <span v-if="phase === 'ready' && history.length > 1" class="bbi-card__pager">
        <button
          class="bbi-btn bbi-btn--mini"
          type="button"
          :disabled="index <= 0"
          @click="index--"
        >
          ◀
        </button>
        <span class="bbi-card__pager-count">{{ index + 1 }}/{{ history.length }}</span>
        <button
          class="bbi-btn bbi-btn--mini"
          type="button"
          :disabled="index >= history.length - 1"
          @click="index++"
        >
          ▶
        </button>
      </span>
      <span class="bbi-card__spacer" />
      <button
        v-if="phase === 'generating'"
        class="bbi-btn"
        type="button"
        @click="cancel"
      >
        取消
      </button>
      <button
        v-else
        class="bbi-btn bbi-btn--primary"
        type="button"
        :disabled="!configured"
        @click="generate"
      >
        {{ phase === 'ready' ? '重新生成' : '生成' }}
      </button>
    </div>

    <button class="bbi-card__prompt-toggle" type="button" @click="promptOpen = !promptOpen">
      {{ promptOpen ? '收起提示词' : '查看提示词' }}
    </button>
    <pre v-if="promptOpen" class="bbi-card__prompt">{{ prompt }}{{ nl ? `\n\n${nl}` : '' }}</pre>

    <div v-if="phase === 'generating'" class="bbi-card__status">生成中…</div>
    <div v-else-if="phase === 'error'" class="bbi-card__status bbi-card__status--error">
      {{ error }}
    </div>
    <template v-else-if="imageSrc">
      <div class="bbi-card__image">
        <img :src="imageSrc" alt="生图结果" />
      </div>
      <div v-if="phase === 'stale'" class="bbi-card__status">
        提示词已修改，上图由旧提示词生成；点「生成」用新提示词重绘
      </div>
    </template>
    <div v-else-if="phase === 'pending' && !comfyActive" class="bbi-card__status">
      出图后端已选 NAI，暂未支持出图；可到柏宝绘「渠道」页切回 ComfyUI
    </div>
    <div v-else-if="phase === 'pending' && !configured" class="bbi-card__status">
      未配置 ComfyUI，请到柏宝绘「渠道」页填写工作流
    </div>
  </div>
</template>
