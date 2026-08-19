/**
 * 复制到剪贴板 —— 全项目统一入口。
 *
 * 原先楼层卡片与灯箱各自内联了一份逐字相同的实现;请求历史页又要在多处复制
 * (提示词/返回正文/整条记录),再抄第三遍就该收口了。
 *
 * 失败一律给 toast 而非静默:剪贴板 API 在非安全上下文(http 访问 ST)下会直接拒绝,
 * 用户需要知道「得手动选文本」,否则会以为点了没反应。
 */
export async function copyText(text: string, okMessage = '已复制'): Promise<boolean> {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    toastr.success(okMessage, '柏宝绘');
    return true;
  } catch {
    toastr.error('复制失败，请手动选择文本', '柏宝绘');
    return false;
  }
}
