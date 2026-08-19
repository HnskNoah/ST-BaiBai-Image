<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import Icon from '@/components/Icon.vue';
import { saveImageFile } from '@/floor/download';
import { copyText } from '@/st/clipboard';
import { modalHost } from '@/state/ui';

/**
 * 图片灯箱(楼层卡片点击放大)。
 *
 * 为什么自建而不用 ST 原生:ST 的灯箱入口 `.mes_img` 只是个 class,真正的
 * expandMessageMedia 读的是 `chat[mesid].extra.media[data-index]` 数据模型,且该函数
 * 模块私有、未导出到 context——光加 class 会直接 bail。走官方 extra.media 那条路能白嫖
 * 灯箱,但图片会被挂到 `.mes_media_wrapper`(.mes_text 的兄弟节点),脱离 tag 的行内位置,
 * 与「图出现在 tag 所在段落」的核心设计冲突,还得再维护一份与 extra.bbiImage 平行的存储。
 *
 * 【长按保存】移动端能长按保存图片,靠三条约束共同保证,改动时务必保留:
 * 1. 只监听 click,绝不在图片上 preventDefault touchstart/touchend——长按唤出系统菜单时
 *    浏览器不会补发 click,两者天然不冲突;一旦自己拦 touch,长按保存立刻失效。
 * 2. 图片不加 user-select:none / -webkit-touch-callout:none / draggable=false。
 * 3. 显式 touch-action:auto 抵消 ST 的 `body{touch-action:none}`
 *    (css/mobile-styles.css:251,移动端 ≤1000px 全局)——它会干扰部分引擎的长按判定。
 * 部分 WebView 壳(酒馆套 App / Termux)callout 仍不可靠,故另给「保存」按钮兜底。
 */

const props = defineProps<{
  src: string;
  /** 提示词原文(复制用);空则不显示复制按钮。 */
  prompt?: string;
  /** 下载文件名。 */
  filename?: string;
  /** 有值才显示删除按钮。 */
  deletable?: boolean;
}>();

const emit = defineEmits<{ close: []; delete: [] }>();

/** 适应屏幕 ↔ 原始尺寸(可平移查看细节)。 */
const zoomed = ref(false);

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  }
}

onMounted(() => {
  // 捕获阶段:抢在 ST 的全局快捷键之前拿到 Esc
  document.addEventListener('keydown', onKeydown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown, true);
});

async function copyPrompt(): Promise<void> {
  await copyText(props.prompt ?? '', '提示词已复制');
}

function save(): void {
  saveImageFile(props.src, props.filename);
}

const promptText = computed(() => (props.prompt ?? '').trim());
</script>

<template>
  <!-- Teleport 到 modalHost(.bbi-root 直接子级):灯箱需要 --bbi-* 主题变量,
       而 lightbox.ts 的容器挂在 shadow root 顶层、在 .bbi-root 之外拿不到变量。
       与 ConfirmDialog 同款手法。 -->
  <Teleport :to="modalHost" :disabled="!modalHost">
    <!-- 遮罩自身承接关闭点击;图片与操作栏 stop 掉,避免误关 -->
    <div class="bbi-lightbox" @click="emit('close')">
      <div class="bbi-lightbox__bar" @click.stop>
        <button class="bbi-lb-btn" type="button" title="保存图片" @click="save">
          <Icon name="download" :size="18" />
        </button>
        <button
          v-if="promptText"
          class="bbi-lb-btn"
          type="button"
          title="复制提示词"
          @click="copyPrompt"
        >
          <Icon name="copy" :size="18" />
        </button>
        <button
          v-if="deletable"
          class="bbi-lb-btn bbi-lb-btn--danger"
          type="button"
          title="删除这张图"
          @click="emit('delete')"
        >
          <Icon name="trash" :size="18" />
        </button>
        <button class="bbi-lb-btn" type="button" title="关闭 (Esc)" @click="emit('close')">
          <Icon name="close" :size="18" />
        </button>
      </div>

      <!-- 图片容器:zoomed 时允许滚动查看原图 -->
      <div class="bbi-lightbox__stage" @click.stop="emit('close')">
        <img
          class="bbi-lightbox__img"
          :src="src"
          alt="生图结果"
          :data-zoomed="zoomed ? '1' : ''"
          @click.stop="zoomed = !zoomed"
        />
      </div>

      <p v-if="promptText" class="bbi-lightbox__prompt" @click.stop>{{ promptText }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.bbi-lightbox {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  /* 与 base.css 的遮罩同款:部分移动端 WebView 不认 inset/百分比链,显式给视口高 */
  height: 100vh;
  height: 100dvh;
  z-index: 10050;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: oklch(0 0 0 / 0.82);
  backdrop-filter: blur(6px);
}

.bbi-lightbox__bar {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.bbi-lb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid oklch(1 0 0 / 0.18);
  border-radius: var(--bbi-radius-pill);
  background: oklch(1 0 0 / 0.1);
  color: oklch(1 0 0 / 0.92);
  cursor: pointer;
  transition:
    background var(--bbi-dur) var(--bbi-ease),
    border-color var(--bbi-dur) var(--bbi-ease);
}

.bbi-lb-btn:hover {
  background: oklch(1 0 0 / 0.2);
  border-color: oklch(1 0 0 / 0.4);
}

.bbi-lb-btn--danger:hover {
  background: var(--bbi-danger);
  border-color: var(--bbi-danger);
  color: #fff;
}

.bbi-lightbox__stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
}

.bbi-lightbox__img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--bbi-radius-sm);
  cursor: zoom-in;
  /* 抵消 ST 的 body{touch-action:none}(css/mobile-styles.css:251):
     它会干扰部分引擎的长按保存判定。见 <script> 顶部注释的三条约束。 */
  touch-action: auto;
}

/* 原始尺寸:超出部分由 __stage 滚动查看 */
.bbi-lightbox__img[data-zoomed='1'] {
  max-width: none;
  max-height: none;
  cursor: zoom-out;
}

.bbi-lightbox__prompt {
  flex: 0 0 auto;
  max-height: 22%;
  overflow-y: auto;
  margin: 0;
  padding: 10px 12px;
  border-radius: var(--bbi-radius-sm);
  background: oklch(1 0 0 / 0.08);
  color: oklch(1 0 0 / 0.85);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  /* 提示词要可选中复制,故此处不禁用选择 */
  user-select: text;
}
</style>
