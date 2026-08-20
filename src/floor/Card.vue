<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { generateComfyImage, randomSeed } from '@/backends/comfyui';
import { generateNaiImage, naiRandomSeed } from '@/backends/nai';
import type { Orientation } from '@/backends/size';
import Icon from '@/components/Icon.vue';
import { confirmDialog } from '@/components/confirm';
import { consumeAutoGenerate } from '@/floor/autoGenerate';
import { imageDownloadFileName, saveImageFile } from '@/floor/download';
import { acquireNaiSlot } from '@/floor/genQueue';
import {
  beginGen,
  cancelGen,
  clearGen,
  failGen,
  getGenRecord,
  isCurrentGen,
  reconcileGen,
  setGenPhase,
  setQueueAhead,
  slotKey,
} from '@/floor/genState';
import { hydrateMessage } from '@/floor/hydrate';
import { openLightbox } from '@/floor/lightbox';
import {
  deleteImageResult,
  promptHash,
  saveImageResult,
  type BbiImageEntry,
} from '@/floor/storage';
import { activeComfyPreset, effectiveComfyConn, settings } from '@/state/settings';
import { beginImage, failImage, finishImage, safeHistory } from '@/state/history';
import { copyText } from '@/st/clipboard';
import { getContext } from '@/st/context';

/**
 * 楼层生图卡片(DESIGN-FLOOR-UI.md §8)。
 *
 * 【重要】本组件是**纯展示层**,不持有运行态。
 * 卡片的生命周期由外部水合决定:任一槽位出图成功都会 hydrateMessage 重水合,
 * 而重水合卸载**整楼**卡片;ST 重渲染楼层时锚点 DOM 也会重建。
 * 运行态(生成中/错误/在途请求)一律存 floor/genState.ts 的模块级 store,按槽位 key 认领,
 * 组件重建后立刻读回——否则会出现「一张图完成,其余卡片的『生成中…』集体消失并退回 pending」
 * (标记已消费,不会自动重跑)。改这里前先读 genState.ts 顶部注释。
 *
 * 展示态分两层:
 * - 运行态(store):queued / generating / error —— 跨重建存活;
 * - 派生态(props):ready(有本提示词历史)/ stale(仅有旧提示词结果)/ pending —— 每次由 props 算出。
 */

const props = defineProps<{
  /** tag 原文解析出的 tag 部分(danbooru 短 tag;展示与生成用)。 */
  prompt: string;
  /** tag 原文解析出的自然语言部分(无则空串;生成时写入 %nl% 占位符)。 */
  nl: string;
  /** tag 原文解析出的动态负面部分(无则空串;生成时写入 %negative_prompt% 占位符)。 */
  negative: string;
  /** 画幅方向(模型判定,随 tag 持久化):决定用渠道配置里的竖屏还是横屏尺寸。 */
  size: Orientation;
  /** tag 原文(含 <bbi_image> 壳):生成提交与 promptHash 的输入。 */
  tag: string;
  messageId: number;
  seq: number;
  swipeId: number;
  /** 当前提示词同槽位的全部历史(时间正序,最新在末尾)。 */
  history: BbiImageEntry[];
  /** 无匹配历史时,旧提示词同槽位的最新结果(stale)。 */
  staleEntry: BbiImageEntry | null;
  /** 所在聊天 id(水合时传入):槽位 key 的一部分,不再各自去 getContext 取。 */
  chatId: string;
}>();

type Phase = 'pending' | 'queued' | 'generating' | 'ready' | 'stale' | 'error';

const key = computed(() => slotKey(props.chatId, props.messageId, props.swipeId, props.seq));
const hash = computed(() => promptHash(props.tag));

/** 翻页位置:默认最新一张。history 变化(新图落盘)后自动跟到最新。 */
const index = ref(props.history.length ? props.history.length - 1 : 0);
watch(
  () => props.history.length,
  length => {
    index.value = length ? length - 1 : 0;
  },
);

const promptOpen = ref(false);

/** 触屏收纳菜单(⋯ 钮)的展开态;桌面 hover 一排直达,不用它。 */
const menuOpen = ref(false);

/** 运行态记录(可能为 undefined = 无在途任务)。 */
const record = computed(() => getGenRecord(key.value));

const phase = computed<Phase>(() => {
  const running = record.value;
  if (running) return running.phase;
  if (props.history.length) return 'ready';
  if (props.staleEntry) return 'stale';
  return 'pending';
});

const error = computed(() => record.value?.error ?? '');
const queueAhead = computed(() => record.value?.queueAhead ?? null);

const comfyActive = computed(() => settings.defaultBackend === 'comfyui');
const naiActive = computed(() => settings.defaultBackend === 'nai');
const configured = computed(() =>
  comfyActive.value
    ? !!settings.comfyui.url.trim() && !!activeComfyPreset().workflow.trim()
    : naiActive.value
      ? !!settings.nai.url.trim() && !!settings.nai.key.trim()
      : false,
);

const current = computed(() => props.history[index.value] ?? null);
/** 提示词全文:复制、灯箱、展开区共用。 */
const promptText = computed(() =>
  [
    props.prompt,
    props.nl,
    props.negative ? `Negative: ${props.negative}` : '',
  ].filter(Boolean).join('\n\n'),
);
/**
 * 当前展示的结果。**刻意不看运行态**:生成失败/重绘中都该继续显示上一张图,
 * 否则「有图 → 点重绘 → 失败」会让图凭空消失(只剩一行报错),看着像把图弄丢了。
 */
const shownEntry = computed(() => (props.history.length ? current.value : props.staleEntry));
const imageSrc = computed(() => shownEntry.value?.path ?? '');
const downloadFileName = (entry: BbiImageEntry): string => {
  const context = getContext();
  const characterName = context?.chat[props.messageId]?.name || context?.name2 || '';
  return imageDownloadFileName(entry.path, characterName, entry.generationId);
};
/** 展示的图是否属于旧提示词(有旧结果但当前提示词还没出过图)。 */
const isStale = computed(() => !props.history.length && !!props.staleEntry);
/** 生成中/排队中仍显示上一张(若有),避免卡片塌空;骨架叠在其上。 */
const busy = computed(() => phase.value === 'generating' || phase.value === 'queued');
/** 历史翻页:多于一张且不在生成中才给。 */
const pageable = computed(() => props.history.length > 1 && !busy.value);

const statusLabel = computed(() => {
  if (phase.value === 'queued') return '排队中…';
  const ahead = queueAhead.value;
  if (phase.value === 'generating' && ahead !== null && ahead > 0) return `排队中(前面 ${ahead} 个)`;
  return '生成中…';
});

/** 无图且后端未就绪时,占位区中央的配置引导。 */
const pendingHint = computed(() => {
  if (!comfyActive.value && !naiActive.value)
    return '出图后端未选择,请到柏宝绘「渠道」页选择出图渠道';
  return naiActive.value
    ? '未配置 NAI,请到柏宝绘「渠道」页填写 API Key'
    : '未配置 ComfyUI,请到柏宝绘「渠道」页填写工作流';
});

async function generate(): Promise<void> {
  if (busy.value || !configured.value) return;
  const slot = key.value;
  const currentHash = hash.value;
  // 本次任务的输入全部就地取值:请求在途时本组件很可能已被重水合销毁
  // (任一兄弟槽位出图都会触发全楼重建),销毁后再读 props 不可靠。
  const job = {
    messageId: props.messageId,
    swipeId: props.swipeId,
    seq: props.seq,
    tag: props.tag,
    prompt: props.prompt,
    nl: props.nl,
    negative: props.negative,
    size: props.size,
  };
  // NAI 需要闸门排队 → 先显示「排队中」;ComfyUI 有服务端队列,直接进 generating
  const { signal, token } = beginGen(slot, currentHash, naiActive.value ? 'queued' : 'generating');
  let release: (() => void) | null = null;
  // 历史记录 id:在 seed 确定后才登记(见下),故这里先置空,catch 里据此判断要不要收尾。
  let historyId: number | null = null;

  try {
    if (naiActive.value) {
      release = await acquireNaiSlot(signal);
      setGenPhase(slot, token, 'generating');
    }
    // 发起时就确定种子并显式传入(NAI 面板种子 > 0 时用固定值;否则随机),
    // 随结果落盘进 extra(entry.seed),历史翻页可查/可复用。
    const seed = naiActive.value
      ? settings.nai.seed > 0
        ? settings.nai.seed
        : naiRandomSeed()
      : randomSeed();
    // 历史埋点:seed 已定、请求将发,此刻登记。图片本身不进 store(dataURL 会爆内存,
    // 且图随后就落盘进 ST 了)——只留元信息 + 楼层坐标,够回溯「这张图是怎么来的」。
    historyId = safeHistory(() =>
      beginImage({
        backend: naiActive.value ? 'nai' : 'comfyui',
        model: naiActive.value ? settings.nai.model : activeComfyPreset().name,
        prompt: job.prompt,
        nl: job.nl,
        negative: job.negative,
        seed,
        size: job.size,
        floor: job.messageId,
        seq: job.seq,
      }),
    );
    const result = naiActive.value
      ? await generateNaiImage(settings.nai, { prompt: job.prompt, seed, size: job.size }, signal)
      : await generateComfyImage(
          effectiveComfyConn(),
          {
            prompt: job.prompt,
            nl: job.nl,
            negative_prompt: job.negative,
            seed,
            size: job.size,
          },
          signal,
          { onQueue: ahead => setQueueAhead(slot, token, ahead) },
        );
    // 图已经拿到手:此时若发现本任务已被取代(取消后重绘 / reconcile),不要落盘,
    // 否则会把旧提示词的结果写进 extra,并触发一次多余的重水合打断新任务。
    if (!isCurrentGen(slot, token)) {
      result.revoke();
      // 图出来了却被丢弃,历史里记成「已取消」——否则这条会永远停在「进行中」。
      if (historyId !== null) safeHistory(() => failImage(historyId!, '', true));
      return;
    }
    // 落盘:图片进 ST 文件系统 + extra 写指针。成功后重水合,
    // 卡片从 extra 恢复为 ready(blob/dataURL 生命周期随之结束)。
    await saveImageResult(job.messageId, job.swipeId, job.seq, job.tag, seed, result);
    result.revoke();
    if (historyId !== null) safeHistory(() => finishImage(historyId!));
    // 先清运行态再重水合:重水合会重建本组件,清完才不会带着 generating 复活
    clearGen(slot, token);
    const ctx = getContext();
    if (ctx) hydrateMessage(job.messageId, ctx);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === 'AbortError';
    if (historyId !== null) {
      safeHistory(() => failImage(historyId!, e instanceof Error ? e.message : String(e), aborted));
    }
    if (aborted) {
      clearGen(slot, token);
    } else {
      failGen(slot, token, e instanceof Error ? e.message : String(e));
    }
  } finally {
    release?.();
  }
}

function cancel(): void {
  cancelGen(key.value);
}

function openImage(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  // 就地取值:灯箱挂在插件 shadow root,**活得比本卡片长**——任一兄弟槽位出图都会
  // 重水合销毁本组件,而灯箱还开着。回调里再读 props 就是读已销毁实例,故全部先快照。
  const at = { messageId: props.messageId, swipeId: props.swipeId };
  openLightbox({
    src: entry.path,
    prompt: promptText.value,
    filename: downloadFileName(entry),
    onDelete: () => void removeEntry(entry, at),
  });
}

/** 删除当前展示的这一条结果(DESIGN-FLOOR-UI.md §8.2)。 */
function removeCurrent(): void {
  const target = shownEntry.value;
  if (!target) return;
  void removeEntry(target, { messageId: props.messageId, swipeId: props.swipeId });
}

/**
 * 删除一条结果。楼层坐标由调用方传入而非现场读 props:
 * 本函数可能在组件销毁后才真正执行(灯箱回调 + 确认弹窗都是异步的)。
 */
async function removeEntry(
  target: BbiImageEntry,
  at: { messageId: number; swipeId: number },
): Promise<void> {
  const ok = await confirmDialog({
    title: '删除这张图',
    text: '图片文件与聊天记录里的指针都会删除,无法恢复。同一提示词的其它历史结果不受影响。',
    confirmText: '删除',
    tone: 'danger',
  });
  if (!ok) return;
  // stale 的图存在别的 hash 桶里,删除要用它自己的 promptHash,不能用当前 tag 的
  const bucketHash = promptHash(target.prompt);
  const removed = await deleteImageResult(
    at.messageId,
    at.swipeId,
    bucketHash,
    target.generationId,
  );
  if (!removed) {
    toastr.error('删除失败,聊天记录未能保存', '柏宝绘');
    return;
  }
  const ctx = getContext();
  if (ctx) hydrateMessage(at.messageId, ctx);
}

async function copyPrompt(): Promise<void> {
  await copyText(promptText.value, '提示词已复制');
}

/** 另存当前展示的这张图(与灯箱共用 download.ts,免得两份逻辑漂移)。 */
function downloadCurrent(): void {
  const entry = shownEntry.value;
  if (!entry) return;
  saveImageFile(entry.path, downloadFileName(entry));
}

// 提示词变更对账放 watch 而非 onMounted:差分水合(hydrate.ts)下同锚点卡片是
// props patch 而非重挂,onMounted 不会再跑;tag 一变必须立刻作废旧提示词的任务。
watch(hash, current => reconcileGen(key.value, current), { immediate: true });

onMounted(() => {
  // 「写入 tag 后自动生成图片」:本槽位带着标记水合挂载 → 消费标记并直接开跑。
  // 只在真·空槽位(pending)时消费:重水合后若已有结果或有在途任务,不该再触发。
  // 未配置后端时不跑(卡片维持 pending,显示配置引导);标记同样消费掉,不留着影响后续手动操作。
  if (phase.value !== 'pending') return;
  if (!props.chatId) return;
  if (!consumeAutoGenerate(props.chatId, props.messageId, props.swipeId, props.seq)) return;
  if (!configured.value) return;
  void generate();
});
</script>

<template>
  <!-- 沉浸式设计:图即卡片。无边框/无背景面板/无品牌栏,控件悬浮在图上,
       桌面 hover 浮现、触屏常驻淡显;提示词收进悬浮按钮唤起的面板,平时零占位。 -->
  <div class="bbi-figure" :data-phase="phase">
    <div class="bbi-figure__stage" :data-size="size" :data-placeholder="imageSrc ? '' : '1'">
      <img
        v-if="imageSrc"
        class="bbi-figure__img"
        :src="imageSrc"
        alt="生图结果"
        @click="openImage"
      />

      <!-- 无图时的生成中:骨架微光扫过占位底 -->
      <div v-if="busy && !imageSrc" class="bbi-figure__skeleton" />

      <!-- 生成中遮罩:绝对定位盖在整个舞台上(有图=磨砂盖住旧图,无图=压住骨架)。
           居中 spinner + 状态 + 取消,不再像旧版那样作为 flex 子项跟图片并排互挤。 -->
      <div v-if="busy" class="bbi-figure__busy">
        <span class="bbi-figure__spin" />
        <span class="bbi-figure__busy-text">{{ statusLabel }}</span>
        <button class="bbi-figure__cancel" type="button" @click="cancel">取消</button>
      </div>

      <!-- 无图且空闲:生成入口 / 配置引导 -->
      <div v-if="!imageSrc && !busy" class="bbi-figure__pending">
        <button v-if="configured" class="bbi-figure__generate" type="button" @click="generate">
          <Icon name="palette" :size="15" />
          {{ phase === 'error' ? '重试' : '生成图片' }}
        </button>
        <p v-else class="bbi-figure__hint">{{ pendingHint }}</p>
      </div>

      <!-- 提示词已改:角标提示,不再整图压暗 -->
      <span v-if="isStale && !busy" class="bbi-figure__badge">旧提示词</span>

      <!-- 悬浮操作组:桌面 hover 浮现一整排;触屏只留 ⋯ 收纳钮,点开竖排展开,
           点任意操作后自动收起(重绘等高频操作两步可达,图片平时只有一颗小点) -->
      <span v-if="!busy" class="bbi-figure__actions" :data-open="menuOpen ? '1' : ''">
        <button
          class="bbi-fab bbi-figure__more"
          type="button"
          title="更多操作"
          :aria-expanded="menuOpen"
          @click="menuOpen = !menuOpen"
        >
          <Icon name="more" :size="15" />
        </button>
        <span class="bbi-figure__menu">
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            :disabled="!configured"
            :title="configured ? '重绘' : '请先在柏宝绘「渠道」页完成配置'"
            @click="menuOpen = false; generate()"
          >
            <Icon name="refresh" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab"
            type="button"
            title="下载这张图"
            @click="menuOpen = false; downloadCurrent()"
          >
            <Icon name="download" :size="15" />
          </button>
          <button
            v-if="shownEntry"
            class="bbi-fab bbi-fab--danger"
            type="button"
            title="删除这张图"
            @click="menuOpen = false; removeCurrent()"
          >
            <Icon name="trash" :size="15" />
          </button>
          <button
            v-if="promptText"
            class="bbi-fab"
            :class="{ 'bbi-fab--on': promptOpen }"
            type="button"
            title="查看提示词"
            :aria-expanded="promptOpen"
            @click="menuOpen = false; promptOpen = !promptOpen"
          >
            <Icon name="text" :size="15" />
          </button>
        </span>
      </span>

      <!-- 翻页器:叠在图片右下角的胶囊 -->
      <span v-if="pageable" class="bbi-figure__pager">
        <button class="bbi-figure__pager-btn" type="button" :disabled="index <= 0" @click="index--">◀</button>
        <span class="bbi-figure__pager-count">{{ index + 1 }}/{{ history.length }}</span>
        <button
          class="bbi-figure__pager-btn"
          type="button"
          :disabled="index >= history.length - 1"
          @click="index++"
        >
          ▶
        </button>
      </span>
    </div>

    <!-- 状态行:仅出错 / 提示词已改时出现,平时零占位 -->
    <p v-if="phase === 'error'" class="bbi-figure__status bbi-figure__status--error">
      {{ error
      }}<button v-if="configured" class="bbi-figure__retry" type="button" @click="generate">
        重试
      </button>
    </p>
    <p v-else-if="isStale && !busy" class="bbi-figure__status bbi-figure__status--warn">
      提示词已修改,上图由旧提示词生成;点右上角重绘用新提示词出图
    </p>

    <!-- 提示词面板:悬浮 文本按钮唤起,复制按钮跟着面板走 -->
    <div v-if="promptOpen && promptText" class="bbi-figure__prompt-box">
      <pre class="bbi-figure__prompt">{{ prompt
        }}<span v-if="nl" class="bbi-figure__prompt-nl">{{ nl }}</span><span
          v-if="negative"
          class="bbi-figure__prompt-nl bbi-figure__prompt-negative"
        >Negative: {{ negative }}</span></pre>
      <button class="bbi-figure__prompt-copy" type="button" title="复制提示词" @click="copyPrompt">
        <Icon name="copy" :size="14" />
      </button>
    </div>
  </div>
</template>
