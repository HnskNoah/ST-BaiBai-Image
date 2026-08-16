/**
 * 正文清洗工具(与柏宝书 timeTag.ts 的 stripCustomTags 完全同口径,改动需双端同步)。
 * 名单来自共享存储(settings.excludes.customStripTags),输入时已由 sanitizeTagName 消毒,
 * 这里只负责按标签名生成「整块删除」正则并执行。
 */

/**
 * 按标签名生成「整块删除」正则(含标签本身与内部内容)。tag 已由 sanitizeTagName 剔除正则元字符,
 * 拼进 RegExp 安全。边界用前瞻 (?=[\s/>]) 而非 \b —— \b 只认 ASCII 词字符,中文标签(如 <雪>)
 * 在 `雪` 与 `>` 之间无词边界会匹配失败;前瞻「标签名后须紧跟空白/斜杠/右括号」对中英文都成立,
 * 且同样防止 <snow> 误吃 <snowball> 前缀。同时删配对块与落单的自闭/单标签。
 */
function blockStripRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), // 配对块
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, 'gi'), // 落单的开/闭/自闭标签
  ];
}

/** 删掉用户在设置里配置的自定义标签(整块:标签 + 内部内容)。空名单则原样返回。 */
export function stripCustomTags(s: string, tags: string[]): string {
  let out = s;
  for (const tag of tags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, '');
  }
  return out;
}
