import { describe, expect, it } from 'vitest';

import { stripCustomTags } from '@/autoTag/clean';

describe('stripCustomTags', () => {
  it('配对块整删(含内部内容)', () => {
    expect(stripCustomTags('前文\n<snow>状态栏内容</snow>\n后文', ['snow'])).toBe('前文\n\n后文');
  });

  it('落单开/闭/自闭标签:只删标签本身', () => {
    expect(stripCustomTags('<snow>内容无闭合', ['snow'])).toBe('内容无闭合');
    expect(stripCustomTags('内容</snow>', ['snow'])).toBe('内容');
    expect(stripCustomTags('内容<snow/>', ['snow'])).toBe('内容');
  });

  it('中文标签名同样生效(前瞻而非词边界)', () => {
    expect(stripCustomTags('<雪>飘雪特效</雪>正文', ['雪'])).toBe('正文');
  });

  it('边界前瞻:不误吃同名前缀标签(<snow> 不吃 <snowball>)', () => {
    expect(stripCustomTags('<snowball>保留</snowball>', ['snow'])).toBe('<snowball>保留</snowball>');
  });

  it('带属性的开标签也整块删除', () => {
    expect(stripCustomTags('前<snow class="bar">内容</snow>后', ['snow'])).toBe('前后');
  });

  it('大小写不敏感', () => {
    expect(stripCustomTags('<SNOW>内容</SNOW>', ['snow'])).toBe('');
  });

  it('空名单 / 无匹配标签:原样返回', () => {
    const s = '<think>思维链</think>正文';
    expect(stripCustomTags(s, [])).toBe(s);
    expect(stripCustomTags(s, ['snow'])).toBe(s);
  });

  it('多个标签依次整删', () => {
    expect(stripCustomTags('<a>1</a>x<b>2</b>y', ['a', 'b'])).toBe('xy');
  });
});
