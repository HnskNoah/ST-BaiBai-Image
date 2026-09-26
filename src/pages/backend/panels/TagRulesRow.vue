<script setup lang="ts">
import { computed, ref } from 'vue';
import BbiSelect from '@/components/BbiSelect.vue';
import BbiTextarea from '@/components/BbiTextarea.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import { newTagRule, normalizeTagRules, type TagRule, type TagRuleTarget } from '@/autoTag/tagRules';
import { settings } from '@/state/settings';

/**
 * 联动加词规则行(渠道共享组件):命中触发词就往该画面的正面 tag / 本画面负面追加配套词。
 *
 * 两渠道(NaiPanel / LatentPanel)共用,靠 target 决定读写哪份规则表:
 * - nai    → settings.nai.tagRules(**目标只给正面**——本画面负面在 NAI 渠道无人消费:
 *             generate.ts 的 NAI 分支不传 negativeExtra,给了负面选项等于「配了不生效」);
 * - latent → settings.latent.tagRules(正负都真生效:negative 会被当 negativeExtra 合并进负面链)。
 *
 * 注入时机在 runner 的**写回正文之前**(taglint 之后),故规则作用的是「写进正文的那份」;
 * 手动编辑弹窗与公开接口不经这条缝(用户自己编辑的内容不重跑规则)。匹配语义见 autoTag/tagRules.ts。
 */
const props = defineProps<{ target: 'nai' | 'latent' }>();

const isLatent = computed(() => props.target === 'latent');
const allowNegative = computed(() => isLatent.value);

const rules = computed(() => (isLatent.value ? settings.latent.tagRules : settings.nai.tagRules));
const enabled = computed<boolean>({
  get: () => (isLatent.value ? settings.latent.tagRulesEnabled : settings.nai.tagRulesEnabled),
  set: value => {
    if (isLatent.value) settings.latent.tagRulesEnabled = value;
    else settings.nai.tagRulesEnabled = value;
  },
});

/** 目标的中文名(静态字面量 → Record;列表行与编辑器共用)。 */
const TARGET_LABEL: Record<TagRuleTarget, string> = { positive: '正面', negative: '负面' };

/** 编辑器里的目标选项;NAI 渠道单选项(见组件头注释)。 */
const targetOptions = computed(() =>
  allowNegative.value
    ? [
        { value: 'positive', label: '正面 tag' },
        { value: 'negative', label: '本画面负面' },
      ]
    : [{ value: 'positive', label: '正面 tag' }],
);

/* ============ 编辑弹窗(草稿态:取消即丢弃,不半途改到生效数据) ============ */

const editorOpen = ref(false);
/** 编辑中规则的 id(新建时在打开弹窗那一刻就生成,保存时据此决定就地替换还是追加)。 */
const editingId = ref('');
const draftName = ref('');
const draftTriggers = ref('');
const draftAdd = ref('');
const draftTarget = ref<TagRuleTarget>('positive');
const draftEnabled = ref(true);

function openEditor(rule: TagRule | null) {
  const base = rule ?? newTagRule(`规则 ${rules.value.length + 1}`);
  editingId.value = base.id;
  draftName.value = base.name;
  draftTriggers.value = base.triggers.join(', ');
  draftAdd.value = base.add.join(', ');
  draftTarget.value = base.target;
  draftEnabled.value = base.enabled;
  editorOpen.value = true;
}

/**
 * 保存:先过规则表清洗(唯一一份 sanitize:trim、去空、剥尖括号、按小写去重)。
 * 空触发词或空加词直接拦下并保持弹窗打开——那种规则永远不会命中,存进设置只会在
 * 日后变成「我明明配了却没生效」的谜题。
 */
function saveEditor() {
  const triggers = draftTriggers.value.split(',').filter(part => part.trim());
  const add = draftAdd.value.split(',').filter(part => part.trim());
  if (!triggers.length) {
    toastr.warning('请先填触发词', '联动加词');
    return;
  }
  if (!add.length) {
    toastr.warning('请先填要追加的词', '联动加词');
    return;
  }

  const [clean] = normalizeTagRules([
    {
      id: editingId.value,
      name: draftName.value,
      triggers,
      add,
      target: draftTarget.value,
      enabled: draftEnabled.value,
    },
  ]);
  const index = rules.value.findIndex(rule => rule.id === editingId.value);
  if (index >= 0) rules.value[index] = clean;
  else rules.value.push(clean);
  editorOpen.value = false;
}

/* ============ 删除(确认弹窗;规则是纯配置,删掉不可恢复) ============ */

const removeOpen = ref(false);
const removeTarget = ref<TagRule | null>(null);

function askRemove(rule: TagRule) {
  removeTarget.value = rule;
  removeOpen.value = true;
}

function confirmRemove() {
  const target = removeTarget.value;
  removeTarget.value = null;
  removeOpen.value = false;
  if (!target) return;
  const index = rules.value.findIndex(rule => rule.id === target.id);
  if (index >= 0) rules.value.splice(index, 1);
}
</script>

<template>
  <div class="tag-rule-head">
    <span class="bbi-field-label">联动加词</span>
    <label class="tag-rule-switch">
      <input v-model="enabled" type="checkbox" class="bbi-checkbox" />
      <span>{{ rules.length ? `已配 ${rules.length} 条` : '暂无规则' }}</span>
    </label>
    <span class="tag-rule-spacer"></span>
    <button
      class="bbi-icon-btn"
      type="button"
      title="新建一条规则"
      aria-label="新建规则"
      @click="openEditor(null)"
    >
      <Icon name="plus" :size="14" />
    </button>
  </div>

  <ul v-if="rules.length" class="bbi-prompt-list">
    <li v-for="rule in rules" :key="rule.id" class="bbi-prompt-item">
      <input
        v-model="rule.enabled"
        type="checkbox"
        class="bbi-checkbox"
        :title="rule.enabled ? '停用这条规则' : '启用这条规则'"
        :aria-label="`启用规则 ${rule.name}`"
      />
      <button class="bbi-prompt-open" type="button" @click="openEditor(rule)">
        <span class="bbi-prompt-name">{{ rule.name }}</span>
        <span class="tag-rule-body">
          {{ rule.triggers.join(' / ') || '(未填触发词)' }}
          →
          <template v-if="rule.add.length">+{{ rule.add.join(', ') }}</template>
          <template v-else>(未填加词)</template>
        </span>
        <span class="bbi-prompt-state">{{ TARGET_LABEL[rule.target] }}</span>
        <Icon name="edit" class="bbi-prompt-edit" />
      </button>
      <button
        class="bbi-icon-btn tag-rule-remove"
        type="button"
        title="删除这条规则"
        aria-label="删除规则"
        @click="askRemove(rule)"
      >
        <Icon name="trash" :size="14" />
      </button>
    </li>
  </ul>

  <p class="bbi-field-hint">
    LLM 生成的画面 tag 里出现触发词时，就往该画面追加配套词（如 <code>nsfw</code> → 正面加
    <code>uncensored</code>）。逗号分段、整段精确、大小写不敏感；注入发生在写回正文之前，
    所以正文、图库、复制提示词看到的都是实际用的词；手动改过的提示词不会重跑规则。
    <template v-if="allowNegative">负面方向与本画面负面一起合并去重后发给站点。</template>
    <template v-else>NAI 渠道只做正面——本画面负面在 NAI 出图时不会被消费。</template>
  </p>

  <ModalMask :open="editorOpen" @close="editorOpen = false">
    <div v-if="editorOpen" class="bbi-modal" role="dialog" aria-modal="true" aria-label="编辑联动加词规则">
      <header class="bbi-modal-head">
        <span class="bbi-modal-title">联动加词规则</span>
        <button class="bbi-icon-mini" type="button" title="关闭" @click="editorOpen = false">
          <Icon name="close" />
        </button>
      </header>

      <div class="bbi-field">
        <div class="bbi-field-head">
          <span class="bbi-field-label">规则名</span>
        </div>
        <input
          class="bbi-input"
          type="text"
          v-model="draftName"
          placeholder="例如：NSFW 脱敏"
          spellcheck="false"
        />
      </div>

      <div class="bbi-field">
        <div class="bbi-field-head">
          <span class="bbi-field-label">触发词</span>
        </div>
        <BbiTextarea v-model="draftTriggers" :rows="2" :max-rows="6" mono placeholder="nsfw, explicit" />
        <p class="bbi-field-hint">
          逗号分隔多个，任一命中即触发；整段精确匹配（不会把 <code>nsfw body</code> 当成 <code>nsfw</code>）。
        </p>
      </div>

      <div class="bbi-field">
        <div class="bbi-field-head">
          <span class="bbi-field-label">加词</span>
        </div>
        <BbiTextarea v-model="draftAdd" :rows="2" :max-rows="6" mono placeholder="uncensored" />
        <p class="bbi-field-hint">逗号分隔多个；追加到目标串末尾，目标串里已有的词不重复加。</p>
      </div>

      <div class="bbi-field">
        <div class="bbi-field-head">
          <span class="bbi-field-label">加到</span>
        </div>
        <BbiSelect v-model="draftTarget" :options="targetOptions" aria-label="加词目标" />
        <p v-if="!allowNegative" class="bbi-field-hint">
          NAI 渠道只提供正面：本画面负面在 NAI 出图时不会被消费（要排除什么用上面的「负面提示词」渠道级那份）。
        </p>
      </div>

      <div class="bbi-field">
        <label class="tag-rule-switch">
          <input v-model="draftEnabled" type="checkbox" class="bbi-checkbox" />
          <span>启用这条规则</span>
        </label>
      </div>

      <footer class="bbi-modal-foot">
        <span class="bbi-modal-foot-spacer"></span>
        <button class="bbi-btn" type="button" @click="editorOpen = false">取消</button>
        <button class="bbi-btn bbi-btn-primary" type="button" @click="saveEditor">完成</button>
      </footer>
    </div>
  </ModalMask>

  <ConfirmDialog
    v-model:open="removeOpen"
    title="删除联动加词规则"
    confirm-text="删除"
    confirm-icon="trash"
    tone="danger"
    @confirm="confirmRemove"
  >
    确定删除规则「{{ removeTarget?.name || '未命名规则' }}」？删除后无法恢复。
  </ConfirmDialog>
</template>

<style scoped>
/* 图标钮与弹窗页脚撑杆:`bbi-icon-btn` / `bbi-icon-mini` / `bbi-modal-foot-spacer` 在
   本仓都是**各组件 scoped 自带**(base.css 里没有),scoped 不跨组件,故此处补一份同款,
   否则这几个钮会退化成浏览器默认样式。 */
.bbi-icon-btn {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface-2);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 13px;
  transition:
    color var(--bbi-dur) var(--bbi-ease),
    background var(--bbi-dur) var(--bbi-ease);
}
.bbi-icon-btn:hover {
  color: var(--bbi-ink);
  background: var(--bbi-line-strong);
}
.bbi-icon-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--bbi-line-strong);
  border-radius: var(--bbi-radius-sm);
  background: var(--bbi-surface);
  color: var(--bbi-ink-soft);
  cursor: pointer;
  font-size: 12px;
}
.bbi-icon-mini:hover {
  color: var(--bbi-accent);
}
.bbi-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 标题行:标签 + 总开关 + 新建(与各面板的 field 行同款节奏) */
.tag-rule-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
.tag-rule-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--bbi-ink-muted);
  cursor: pointer;
}
.tag-rule-spacer {
  flex: 1 1 auto;
}
/* 列表行(与 NaiPanel/LatentPanel 的正/负面词列表同款,scoped 需各抄一份) */
.bbi-prompt-list {
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbi-prompt-item {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbi-prompt-open {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--bbi-line);
  border-radius: var(--bbi-radius);
  background: var(--bbi-surface-2);
}
.bbi-prompt-open:hover {
  border-color: var(--bbi-accent);
  background: var(--bbi-surface);
}
.bbi-prompt-name {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 600;
}
.bbi-prompt-edit {
  flex: 0 0 auto;
  font-size: 16px;
  color: var(--bbi-ink-muted);
}
.bbi-prompt-open:hover .bbi-prompt-edit {
  color: var(--bbi-accent);
}
/* 触发词 → 加词 的机器可读串:等宽、可截断(窄屏另起一行,见媒体查询) */
.tag-rule-body {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--bbi-mono, ui-monospace, monospace);
  font-size: 12px;
  color: var(--bbi-ink-muted);
}
.tag-rule-remove {
  flex: 0 0 auto;
  color: var(--bbi-danger);
}
.tag-rule-remove:hover {
  background: var(--bbi-danger-soft);
}
/* 窄屏:标签独占首行,触发词串与目标药丸同行分据两端(与画师串行的窄屏口径一致) */
@media (max-width: 640px) {
  .bbi-prompt-open {
    flex-wrap: wrap;
    row-gap: 4px;
  }
  .bbi-prompt-name {
    flex: 1 1 100%;
  }
  .tag-rule-body {
    flex: 1 1 auto;
  }
}
</style>
