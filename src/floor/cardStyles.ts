import cardCss from '@/floor/card.css?raw';

/**
 * 楼层卡片样式注入 document.head（幂等）。
 * 卡片活在楼层 light DOM，必须用 document.head 样式；data-bbi-style 标记防重复。
 */
const STYLE_ID = 'bbi-floor-card-styles';

export function injectCardStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-bbi-style', '');
  style.textContent = cardCss;
  document.head.appendChild(style);
}
