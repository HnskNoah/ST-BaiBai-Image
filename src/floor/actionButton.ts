import { requestFloorTags } from '@/autoTag/runner';
import { confirmDialog } from '@/components/confirm';
import { settings } from '@/state/settings';
import { getContext } from '@/st/context';

/**
 * 楼层「生成生图 tag」按钮注入。
 *
 * 每个 AI 楼层的 .extraMesButtons(ST 扩展按钮区,"⋯" 展开)追加一个调色板按钮
 * (与扩展菜单入口同款图标):
 * - 无 tag 的楼:直接分析并写入 tag;
 * - 已有 tag 的楼:先弹插件自绘确认窗,确认后剔除旧 tag、重新分析写入
 *   (旧图片保留在卡片历史里,新 tag 的卡片按 stale 机制展示旧图)。
 *
 * 只给 AI 楼(is_user=false 且 is_system=false);用户楼不给,与自动流程口径一致。
 * 按钮是纯 DOM(fa 图标与 ST 原生扩展按钮同款观感),不进 Vue 树。
 * ST 重渲染会重建楼层 DOM,MutationObserver 负责幂等补注。
 */

const BUTTON_CLASS = 'bbi-tag-action';
// 与扩展菜单入口同款调色板图标
const ICON_CLASS = 'fa-palette';

let observer: MutationObserver | null = null;
let syncScheduled = false;

function isAiFloor(mesEl: HTMLElement): boolean {
  return mesEl.getAttribute('is_user') === 'false' && mesEl.getAttribute('is_system') === 'false';
}

function setRunning(button: HTMLElement, running: boolean): void {
  button.dataset.running = running ? '1' : '';
  button.classList.toggle(ICON_CLASS, !running);
  button.classList.toggle('fa-spinner', running);
  button.classList.toggle('fa-spin', running);
}

async function onActivate(button: HTMLElement): Promise<void> {
  if (button.dataset.running === '1') return;
  const floor = Number(button.closest('.mes')?.getAttribute('mesid'));
  const context = getContext();
  const message = Number.isInteger(floor) ? context?.chat?.[floor] : undefined;
  if (!context || !message) return;
  if (!settings.enabled) {
    toastr.warning('柏宝绘已停用，请先在插件设置里开启', '柏宝绘');
    return;
  }

  const hasTags = /<bbi_image\b/i.test(message.mes ?? '');
  if (hasTags) {
    const ok = await confirmDialog({
      title: '重新生成 tag',
      text: '本楼已有生图 tag。重新生成会先删除原 tag 再写入新的；已生成的图片保留在卡片历史里，不会丢失。',
      confirmText: '重新生成',
    });
    if (!ok) return;
  }

  setRunning(button, true);
  try {
    await requestFloorTags(floor, { replace: hasTags });
  } finally {
    // 运行期间 ST 可能已重渲染移除本按钮;对脱离 DOM 的元素改 class 是安全无操作
    setRunning(button, false);
  }
}

function createButton(): HTMLDivElement {
  const button = document.createElement('div');
  // mes_button 与 .extraMesButtons 里的 ST 原生扩展按钮同类(menu_button 是通用菜单按钮,样式不同)
  button.className = `mes_button fa-solid ${ICON_CLASS} ${BUTTON_CLASS}`;
  button.title = '生成生图 tag（已有 tag 时重新生成）';
  button.setAttribute('role', 'button');
  button.setAttribute('tabindex', '0');

  const activate = () => void onActivate(button);
  button.addEventListener('click', activate);
  button.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate();
    }
  });
  return button;
}

function syncButtons(): void {
  for (const mesEl of document.querySelectorAll<HTMLElement>('#chat .mes')) {
    if (!isAiFloor(mesEl)) continue;
    const extra = mesEl.querySelector('.extraMesButtons');
    if (!extra || extra.querySelector(`.${BUTTON_CLASS}`)) continue;
    extra.appendChild(createButton());
  }
}

/** 绑定楼层按钮注入(幂等)。#chat 在 ST 静态模板里,绑定时不存在则说明环境异常,直接放弃。 */
export function bindTagActionButtons(): boolean {
  if (observer) return true;
  const chat = document.getElementById('chat');
  if (!chat) return false;

  observer = new MutationObserver(() => {
    if (syncScheduled) return;
    syncScheduled = true;
    // 合并同一帧内的连续变更(流式渲染期间 Mutation 很密)
    requestAnimationFrame(() => {
      syncScheduled = false;
      syncButtons();
    });
  });
  observer.observe(chat, { childList: true, subtree: true });
  syncButtons();
  return true;
}
