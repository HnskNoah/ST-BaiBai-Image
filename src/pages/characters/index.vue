<script setup lang="ts">
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { generateCharTags } from '@/autoTag/charAnchors';
import { readBookMemory } from '@/autoTag/bookMemory';
import {
  charTagLib,
  removeCharTag,
  upsertCharTag,
  type CharTagEntry,
} from '@/state/charTags';
import { getContext } from '@/st/context';
import { ref } from 'vue';

/**
 * 角色管理 —— 当前聊天的固定外貌 tag 库(仅本聊天生效,存 chatMetadata)。
 * 生成 tag 时,库中角色的 tag 串会作为「必须原样复制」的锚注入提示词,避免每次重写外貌产生偏移。
 * 只记录固定基础特征(发色/瞳色/体型等);服装、状态等变动内容不入库,仍按剧情现场生成。
 */

interface Draft {
  name: string;
  tags: string;
}

// editingName:正在编辑的已有条目名;null = 新建。弹窗开关以 draft 是否存在为准。
const editingName = ref<string | null>(null);
const draft = ref<Draft | null>(null);
// 草稿来源:手改内容即转 manual(防止自动重转覆盖用户修改);「从柏宝书重新生成」后转 book。
const draftSource = ref<CharTagEntry['source']>('manual');
const draftDesc = ref('');
const regenerating = ref(false);

function openEntry(entry: CharTagEntry) {
  editingName.value = entry.name;
  draft.value = { name: entry.name, tags: entry.tags };
  draftSource.value = entry.source;
  draftDesc.value = entry.desc;
}

function addEntry() {
  editingName.value = null;
  draft.value = { name: '', tags: '' };
  draftSource.value = 'manual';
  draftDesc.value = '';
}

function closeEntry() {
  editingName.value = null;
  draft.value = null;
  regenerating.value = false;
}

/** 文本框被手动编辑 → 视为手动来源(自动重转只认「从柏宝书重新生成」按钮的结果) */
function markManual() {
  draftSource.value = 'manual';
  draftDesc.value = '';
}

function confirmEntry() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  const tags = d.tags.trim();
  if (!name || !tags) {
    toastr.warning('角色名和固定外貌 tag 都不能为空', '柏宝绘');
    return;
  }
  const ok = upsertCharTag(
    { name, tags, source: draftSource.value, desc: draftDesc.value },
    editingName.value ?? undefined,
  );
  if (ok) closeEntry();
}

/* —— 删除:二次确认 —— */
const confirmDeleteOpen = ref(false);
function askRemove() {
  confirmDeleteOpen.value = true;
}
function confirmRemove() {
  confirmDeleteOpen.value = false;
  if (editingName.value) removeCharTag(editingName.value);
  closeEntry();
}

/* —— 从柏宝书最新状态重新生成:取最新楼的角色参考,找到同名角色的外貌记录,批量转换接口转 tag —— */
async function regenerateFromBook() {
  const d = draft.value;
  if (!d) return;
  const name = d.name.trim();
  if (!name) {
    toastr.warning('先填写角色名', '柏宝绘');
    return;
  }
  const ctx = getContext();
  const floor = (ctx?.chat.length ?? 0) - 1;
  if (!ctx || floor < 0) {
    toastr.info('当前没有打开的聊天', '柏宝绘');
    return;
  }
  regenerating.value = true;
  try {
    const memory = readBookMemory(floor, ctx.chat[floor]?.mes ?? '', ctx.name1);
    const role = memory?.roles.find(r => r.name === name);
    if (!role?.desc) {
      toastr.info('柏宝书最新状态里没有该角色的外貌记录,可手动填写 tag', '柏宝绘');
      return;
    }
    const [result] = await generateCharTags([{ name, desc: role.desc }]);
    if (!result) {
      toastr.warning('模型没有返回该角色的 tag,请重试或手动填写', '柏宝绘');
      return;
    }
    d.tags = result.tags;
    draftSource.value = 'book';
    draftDesc.value = role.desc;
    toastr.success('已按柏宝书最新外貌生成,点「完成」保存', '柏宝绘');
  } catch (error) {
    toastr.error(error instanceof Error ? error.message : String(error), '柏宝绘');
  } finally {
    regenerating.value = false;
  }
}

function sourceLabel(entry: CharTagEntry): string {
  return entry.source === 'book' ? '柏宝书' : '手动';
}
</script>

<template>
  <section class="bbi-page">
    <div class="bbi-page-head">
      <h2 class="bbi-title bbi-title-sub">角色管理</h2>
      <span class="bbi-count" title="本聊天已记录的角色数">{{ charTagLib.entries.length }}</span>
    </div>
    <hr class="bbi-rule" />

    <p class="bbi-field-hint">
      这里记录每个角色的<strong>固定外貌 tag</strong>(发色、瞳色、体型等基础特征,不含服装)。
      生成图片 tag 时会原样注入,保证同一角色外貌稳定不偏移;柏宝书没记录外貌的角色可在此手动补一条。
      仅当前聊天生效,不跨聊天。
    </p>

    <div class="bbi-char-bar">
      <span class="bbi-field-label">本聊天的角色</span>
      <button class="bbi-btn bbi-btn-primary bbi-btn-sm" type="button" @click="addEntry">
        <Icon name="plus" /> 添加角色
      </button>
    </div>

    <ul v-if="charTagLib.entries.length" class="bbi-char-list">
      <li v-for="entry in charTagLib.entries" :key="entry.name" class="bbi-char-item">
        <button class="bbi-char-open" type="button" @click="openEntry(entry)">
          <span class="bbi-char-name">{{ entry.name }}</span>
          <span class="bbi-char-tags">{{ entry.tags }}</span>
          <span class="bbi-char-src" :class="{ 'is-book': entry.source === 'book' }">
            {{ sourceLabel(entry) }}
          </span>
        </button>
      </li>
    </ul>
    <p v-else class="bbi-field-hint">
      还没有记录。生成 tag 时,柏宝书里有外貌的角色会自动转换入库;也可以点「添加角色」手动补。
    </p>

    <!-- ===== 角色编辑弹窗 ===== -->
    <ModalMask :open="!!draft" @close="closeEntry">
      <div v-if="draft" class="bbi-modal" role="dialog" aria-modal="true" aria-label="编辑角色">
        <header class="bbi-modal-head">
          <span class="bbi-modal-title">{{ editingName ? '编辑角色' : '添加角色' }}</span>
          <button class="bbi-icon-mini" type="button" title="关闭" @click="closeEntry"><Icon name="close" /></button>
        </header>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">角色名</span>
          <input v-model="draft.name" class="bbi-input" placeholder="与正文/柏宝书中的名字一致" @input="markManual" />
        </label>
        <span class="bbi-field-hint">按这个名字去正文和柏宝书角色参考里匹配;改名不会自动跟随。</span>

        <label class="bbi-modal-field">
          <span class="bbi-modal-label">固定外貌 tag</span>
          <textarea
            v-model="draft.tags"
            class="bbi-input bbi-char-tags-area"
            placeholder="如 1girl, long black hair, red eyes, small breasts"
            spellcheck="false"
            rows="4"
            @input="markManual"
          ></textarea>
        </label>
        <span class="bbi-field-hint">
          只写固定基础特征(性别/发色发型/瞳色/体型等),不要写服装、表情、动作——那些每次按剧情生成。
          当前来源:{{ draftSource === 'book' ? '柏宝书自动转换' : '手动填写' }};手动编辑内容后按手动保存。
        </span>

        <footer class="bbi-modal-foot">
          <button v-if="editingName" class="bbi-btn bbi-btn-danger" type="button" @click="askRemove">
            <Icon name="trash" /> 删除
          </button>
          <span class="bbi-modal-foot-spacer"></span>
          <button
            class="bbi-btn"
            type="button"
            title="读取柏宝书最新状态里该角色的外貌,重新转换成 tag"
            :disabled="regenerating"
            @click="regenerateFromBook"
          >
            <Icon name="refresh" /> {{ regenerating ? '生成中…' : '从柏宝书生成' }}
          </button>
          <button class="bbi-btn bbi-btn-primary" type="button" @click="confirmEntry">完成</button>
        </footer>

        <ConfirmDialog
          v-model:open="confirmDeleteOpen"
          title="删除角色"
          confirm-text="删除"
          confirm-icon="trash"
          tone="danger"
          top-layer
          @confirm="confirmRemove"
        >
          确定删除「{{ editingName }}」的固定外貌 tag 吗?之后生成时该角色的外貌将不再锚定。
        </ConfirmDialog>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
/* —— 计数药丸:与设置页版本号同款观感 —— */
.bbi-count {
  border: 0;
  padding: 7px 12px;
  border-radius: var(--bbi-radius-pill);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  font-family: var(--bbi-font-mono);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.bbi-char-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin: 12px 0;
}

/* —— 角色列表:沿用渠道列表观感,整行可点进弹窗编辑 —— */
.bbi-char-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-char-open {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink);
  font-family: var(--bbi-font-sans);
  cursor: pointer;
  text-align: left;
  transition:
    border-color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-char-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
.bbi-char-name {
  flex: 0 0 auto;
  max-width: 34%;
  font-size: 14px;
  font-weight: 600;
  word-break: break-word;
}
/* tag 预览:次要信息,过长截断 */
.bbi-char-tags {
  flex: 1 1 auto;
  min-width: 0;
  font-family: var(--bbi-font-mono);
  font-size: 12px;
  color: var(--bbi-ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 来源药丸:手动 muted,柏宝书转强调 */
.bbi-char-src {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 9px;
  border-radius: var(--bbi-radius-pill);
  color: var(--bbi-ink-muted);
  background: var(--bbi-surface);
  border: 1px solid var(--bbi-line);
}
.bbi-char-src.is-book {
  color: var(--bbi-accent);
  background: var(--bbi-accent-soft);
  border-color: transparent;
}

.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 14px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
  border-color: var(--bbi-accent);
}

.bbi-char-tags-area {
  resize: vertical;
  min-height: 72px;
  line-height: 1.6;
  font-family: var(--bbi-font-mono);
  font-size: 12.5px;
}

.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
.bbi-btn-danger {
  color: var(--bbi-danger);
  border-color: var(--bbi-line-strong);
}
.bbi-btn-danger:hover {
  color: var(--bbi-danger);
  border-color: var(--bbi-danger);
  background: var(--bbi-danger-soft);
}

@media (max-width: 640px) {
  .bbi-char-name {
    font-size: 13px;
  }
  .bbi-char-tags {
    font-size: 11px;
  }
}
</style>
