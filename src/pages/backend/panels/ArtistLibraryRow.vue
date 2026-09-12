<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import BbiSelect from '@/components/BbiSelect.vue';
import NaiArtistManager from '@/pages/backend/panels/NaiArtistManager.vue';
import { deleteUserImage } from '@/st/images';
import { newNaiArtist, settings, type NaiArtistPreset } from '@/state/settings';
import {
  BUILTIN_LATENT_ARTISTS,
  BUILTIN_NAI_ARTISTS,
  isBuiltinLatentArtist,
  isBuiltinNaiArtist,
} from '@/backends/nai';

/**
 * 画师串库行(渠道共享组件):下拉管「高频切换」,旁边五个图标钮管「低频操作」——
 * 打开管理弹窗、改名、新建、复制、删除,删除确认与管理弹窗都内聚在本组件里。
 *
 * 两渠道(NaiPanel / LatentPanel)共用,靠 target 决定读写的库:
 * - nai    → settings.nai.artistPresets ∪ BUILTIN_NAI_ARTISTS(NAI 官方配方,artist: 格式)
 * - latent → settings.latent.artistPresets ∪ BUILTIN_LATENT_ARTISTS(Anima 模板,@ 格式)
 * 两份库互相独立,操作互不可见;数据不变式(悬空清空不回落、内置只读、复制不带预览图)
 * 与 NaiPanel 原实现逐字一致。
 *
 * 刻意不看出图后端:本行解析的是「所属渠道页」的库,与当前出图渠道是谁无关
 * (见 settings.ts 的 artistForTarget)。
 */
const props = defineProps<{ target: 'nai' | 'latent' }>();

const isLatent = computed(() => props.target === 'latent');

const library = computed(() =>
  isLatent.value ? settings.latent.artistPresets : settings.nai.artistPresets,
);
const builtins = computed(() =>
  isLatent.value ? BUILTIN_LATENT_ARTISTS : BUILTIN_NAI_ARTISTS,
);

/**
 * 当前选中的画师串;null = 不使用(库为空、用户主动选了「不使用」、或 id 悬空)。
 * settings 是 reactive,改名时直接就地写字段。
 */
const current = computed<NaiArtistPreset | null>(() => {
  const id = isLatent.value ? settings.latent.activeArtistId : settings.nai.activeArtistId;
  if (!id) return null;
  return library.value.find(a => a.id === id) ?? builtins.value.find(a => a.id === id) ?? null;
});

/** 「不使用」的下拉值。preset id 恒为 art_* / bi_* 形状,空串不会与任何一条相撞,无需装箱。 */
const NO_ARTIST = '';

const options = computed(() => [
  { value: NO_ARTIST, label: '不使用' },
  // 内置配方排用户库前面;名称后括注内置,与用户自建的同名条目区分开
  ...builtins.value.map(a => ({ value: a.id, label: `${a.name}(内置)` })),
  ...library.value.map(a => ({ value: a.id, label: a.name || '未命名画师串' })),
]);

/**
 * 下拉的值取「实际生效的那一条」而非存的 id:存的 id 悬空时 current 返回 null,
 * 下拉也该跟着显示「不使用」,不能显示空白。
 */
const activeId = computed<string>({
  get: () => current.value?.id ?? NO_ARTIST,
  set: id => {
    if (isLatent.value) settings.latent.activeArtistId = id;
    else settings.nai.activeArtistId = id;
  },
});

/** 改名/复制/删除都只对「真的选中了一条」有意义;选「不使用」时一律禁用。 */
const hasArtist = computed(() => current.value !== null);

/** 当前选中的是内置配方:只读(改名/删除/内容编辑禁用),「复制」是自定义的唯一入口。 */
const isBuiltinArtist = computed(() =>
  current.value ? (isLatent.value ? isBuiltinLatentArtist(current.value.id) : isBuiltinNaiArtist(current.value.id)) : false,
);

/** 改名是低频操作:平时只显示下拉,点「改名」才把选择器原地换成输入框。 */
const renaming = ref(false);
const nameDraft = ref('');
const nameInput = ref<HTMLInputElement | null>(null);
const deleteOpen = ref(false);
/** 管理器弹窗(按 target 管理各自的库):搜索/预览图/勾选批量删除都在那边。 */
const managerOpen = ref(false);

function startRename() {
  if (!current.value || isBuiltinArtist.value) return; // 内置只读(按钮已禁用,双保险)
  nameDraft.value = current.value.name;
  renaming.value = true;
  nextTick(() => nameInput.value?.focus());
}

/** Enter / 失焦都算确认;Esc 直接置 renaming=false 不经过这里,即为取消。 */
function commitRename() {
  if (renaming.value && current.value) current.value.name = nameDraft.value.trim();
  renaming.value = false;
}

function addArtist() {
  const preset = newNaiArtist(`画师串 ${library.value.length + 1}`);
  library.value.push(preset);
  if (isLatent.value) settings.latent.activeArtistId = preset.id;
  else settings.nai.activeArtistId = preset.id;
}

function duplicateArtist() {
  const src = current.value;
  if (!src) return;
  // 只换 id 与名字;id 生成仍由 settings 统一口径。
  // 内置配方也走这里:复制出来的副本是普通用户条目,随便改——这是内置条唯一的自定义路径。
  // 显式逐字段拷贝,不带 previewPath:预览文件随原条目删除,共指一个路径会让副本日后破图。
  const preset: NaiArtistPreset = {
    id: newNaiArtist().id,
    name: `${src.name} 副本`,
    prompt: src.prompt,
    quality: src.quality,
    negative: src.negative,
  };
  library.value.push(preset);
  if (isLatent.value) settings.latent.activeArtistId = preset.id;
  else settings.nai.activeArtistId = preset.id;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function confirmRemove() {
  deleteOpen.value = false;
  const list = library.value;
  const index = list.findIndex(a => a.id === current.value?.id);
  if (index < 0) return;
  // 预览图文件 best-effort 连带清理(与管理器删除同口径:文件删不掉不阻塞删条目)
  const previewPath = list[index].previewPath;
  if (previewPath) {
    try {
      await deleteUserImage(previewPath);
    } catch (error) {
      toastr.warning(`条目已删除,但预览图文件清理失败：${errorMessage(error)}`, '画师串');
    }
  }
  list.splice(index, 1);
  // 接位到原位置那一条(已是最后一条则退一格);删空了就回「不使用」——
  // `?? ''` 正是画师串库与工作流库的分水岭(那边恒非空、回落 [0]),不能省。
  const nextId = list[Math.min(index, list.length - 1)]?.id ?? '';
  if (isLatent.value) settings.latent.activeArtistId = nextId;
  else settings.nai.activeArtistId = nextId;
}
</script>

<template>
  <div class="art-row">
    <span class="bbi-field-label">画师串</span>
    <input
      v-if="renaming"
      ref="nameInput"
      class="bbi-input"
      type="text"
      v-model="nameDraft"
      placeholder="画师串名称"
      spellcheck="false"
      title="Enter 确认，Esc 取消"
      @keydown.enter.prevent="commitRename"
      @keydown.esc.stop.prevent="renaming = false"
      @blur="commitRename"
    />
    <BbiSelect
      v-else
      class="art-select"
      v-model="activeId"
      :options="options"
      aria-label="当前画师串"
    />
    <span v-if="!renaming" class="art-ops">
      <button
        class="bbi-icon-btn art-op"
        type="button"
        title="管理画师串库:搜索、预览图、批量删除"
        aria-label="管理画师串库"
        @click="managerOpen = true"
      >
        <Icon name="grid" :size="14" />
      </button>
      <button
        class="bbi-icon-btn art-op"
        type="button"
        :disabled="!hasArtist || isBuiltinArtist"
        :title="
          !hasArtist
            ? '未选中画师串'
            : isBuiltinArtist
              ? '内置画师串不可改名,点复制建一条自己的'
              : '重命名当前画师串'
        "
        aria-label="重命名当前画师串"
        @click="startRename"
      >
        <Icon name="edit" :size="14" />
      </button>
      <button
        class="bbi-icon-btn art-op"
        type="button"
        title="新建一条空画师串"
        aria-label="新建一条空画师串"
        @click="addArtist"
      >
        <Icon name="plus" :size="14" />
      </button>
      <button
        class="bbi-icon-btn art-op"
        type="button"
        :disabled="!hasArtist"
        :title="
          !hasArtist
            ? '未选中画师串'
            : isBuiltinArtist
              ? '复制为我的画师串,复制出来的可以随便改'
              : '复制当前画师串'
        "
        aria-label="复制当前画师串"
        @click="duplicateArtist"
      >
        <Icon name="copy" :size="14" />
      </button>
      <button
        class="bbi-icon-btn art-op art-remove"
        type="button"
        :disabled="!hasArtist || isBuiltinArtist"
        :title="
          !hasArtist
            ? '未选中画师串'
            : isBuiltinArtist
              ? '内置画师串不可删除,它会随插件版本更新'
              : '删除当前画师串'
        "
        aria-label="删除当前画师串"
        @click="deleteOpen = true"
      >
        <Icon name="trash" :size="14" />
      </button>
    </span>
  </div>

  <NaiArtistManager v-model:open="managerOpen" :target="target" />

  <ConfirmDialog
    v-model:open="deleteOpen"
    title="删除画师串"
    confirm-text="删除"
    confirm-icon="trash"
    tone="danger"
    @confirm="confirmRemove"
  >
    确定删除画师串「{{ current?.name || '未命名画师串' }}」？删除后无法恢复。
  </ConfirmDialog>
</template>

<style scoped>
/* 与 NaiPanel 原 art-row 同款(抽取后由本组件自带,面板里不再重复声明) */
.art-row {
  display: grid;
  grid-template-columns: 5.5em minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
}
.art-row > .bbi-field-label:first-child {
  white-space: nowrap;
}
.art-row > .bbi-input {
  min-width: 0;
}
.art-row > .art-select {
  width: auto;
  max-width: 320px;
  min-width: 0;
}
.art-ops {
  display: flex;
  gap: 4px;
  justify-self: end;
}
.art-op {
  width: 30px;
  height: 30px;
  font-size: 13px;
}
.art-op:disabled {
  opacity: 0.4;
  cursor: default;
}
.art-remove:not(:disabled) {
  color: var(--bbi-danger);
}
.art-remove:not(:disabled):hover {
  color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}
</style>
