import { normalizeOrientation, type Orientation } from '@/backends/size';

export interface ImageInsertion {
  line: number;
  /** danbooru 短 tag 部分(必填)。 */
  tag: string;
  /** 自然语言部分(可空;ComfyUI「生成自然语言」开启时由模型一并输出)。 */
  nl: string;
  /** 画幅方向:模型只判横/竖,具体像素由用户在后端面板配置。漏给/乱给一律降级竖屏。 */
  size: Orientation;
}

export interface ImagePlan {
  images: ImageInsertion[];
}

interface SourceLine {
  text: string;
  eol: string;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const newline = /\r\n|\n|\r/g;
  let start = 0;
  for (let match = newline.exec(source); match; match = newline.exec(source)) {
    lines.push({ text: source.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  lines.push({ text: source.slice(start), eol: '' });
  return lines;
}

/** 给每个源码物理行编号；空行也占一个行号，保证返回数字能无歧义地映射回原文。 */
export function numberSourceText(source: string): string {
  const lines = sourceLines(source);
  const width = Math.max(4, String(lines.length).length);
  return lines.map((line, index) => `[L${String(index + 1).padStart(width, '0')}] ${line.text}`).join('\n');
}

export function sourceLineCount(source: string): number {
  return sourceLines(source).length;
}

function jsonObjects(raw: string): string[] {
  const cleaned = raw.replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  const candidates: string[] = [];
  for (const match of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());
  candidates.push(cleaned);

  for (let start = 0; start < cleaned.length; start += 1) {
    if (cleaned[start] !== '{') continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < cleaned.length; index += 1) {
      const char = cleaned[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === '{') depth += 1;
      else if (char === '}' && --depth === 0) {
        candidates.push(cleaned.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function parseObject(raw: string): Record<string, unknown> {
  for (const candidate of jsonObjects(raw)) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    } catch {
      // 尝试下一个候选 JSON 块。
    }
  }
  throw new Error('AI 没有返回可解析的 JSON 对象');
}

/** tag / nl 内容里不允许出现的子标签字面量(会污染 bbi_image 内部解析)。 */
const FORBIDDEN_SUBTAG = /<\/?(?:bbi_image|tag|nl|size)\b/i;

function sanitizeContent(value: unknown, field: string, index: number): string {
  const text = typeof value === 'string' ? value.trim().replace(/[\r\n]+/g, ' ') : '';
  if (text && FORBIDDEN_SUBTAG.test(text)) {
    throw new Error(`images[${index}].${field} 不得包含 bbi_image/tag/nl/size 标签`);
  }
  return text;
}

/**
 * 解析并严格校验模型给出的“源码行号 + 提示词”列表。tag 必填;nl 选填,漏给宽容降级为纯 tag。
 * size 一律容忍:归一不出就当竖屏——为它抛错会白白吃掉 runner 的重试次数。
 */
export function parseImagePlan(raw: string, lineCount: number, maxImages: number): ImagePlan {
  const parsed = parseObject(raw);
  if (!Array.isArray(parsed.images)) throw new Error('AI 返回的 JSON 缺少 images 数组');

  const images: ImageInsertion[] = [];
  for (let index = 0; index < parsed.images.length; index += 1) {
    const item = parsed.images[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`images[${index}] 必须是对象`);
    }
    const entry = item as Record<string, unknown>;
    if (!Number.isInteger(entry.line)) throw new Error(`images[${index}].line 必须是整数`);
    const line = entry.line as number;
    if (line < 1 || line > lineCount) {
      throw new Error(`images[${index}].line=${line} 超出目标正文 1-${lineCount} 行的范围`);
    }
    // 兼容模型按旧协议/习惯返回 prompt 键的情况
    const tag = sanitizeContent(entry.tag ?? entry.prompt, 'tag', index);
    if (!tag) throw new Error(`images[${index}].tag 不能为空`);
    const nl = sanitizeContent(entry.nl, 'nl', index);
    // 兼容模型按习惯返回 orientation / aspect 键
    const size = normalizeOrientation(entry.size ?? entry.orientation ?? entry.aspect);
    images.push({ line, tag, nl, size });
  }

  return { images: images.slice(0, Math.max(0, Math.floor(maxImages))) };
}

/** 保持原文及原换行符不变，只在指定源码行之后插入 tag。 */
export function injectImageTags(source: string, images: ImageInsertion[]): string {
  if (!images.length) return source;
  const lines = sourceLines(source);
  const byLine = new Map<number, ImageInsertion[]>();
  for (const image of images) {
    const list = byLine.get(image.line) ?? [];
    list.push(image);
    byLine.set(image.line, list);
  }

  const fallbackEol = lines.find(line => line.eol)?.eol || '\n';
  let output = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    output += line.text;
    const inserted = byLine.get(index + 1) ?? [];
    const insertedEol = line.eol || fallbackEol;
    // 标准形态:tag 部分保持裸文本(与存量格式一致),nl 与 size 各包子标签。
    // size 恒写出:生成是延后的(点卡片才出图),方向必须随 tag 持久化在正文里。
    for (const image of inserted) {
      const nl = image.nl ? `<nl>${image.nl}</nl>` : '';
      output += `${insertedEol}<bbi_image>${image.tag}${nl}<size>${image.size}</size></bbi_image>`;
    }
    output += line.eol;
  }
  return output;
}
