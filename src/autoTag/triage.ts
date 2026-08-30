// 助手回复分诊(纯函数,零依赖):判断一段回复文本属于「正常 / 空回 / API 错误文本」。
// 规则与 ST-Quicker-Api 的 src/response-triage/response-triage.ts 同源(那边是对外沉淀的
// 规范版本,此处为消费方拷贝),两端口径必须保持一致:那边演进规则时,这里同步过来。
//
// 用途:正文是 API 错误标记或空回的楼层没有可分析的画面,自动 tag 全流程直接放弃,
// 不把「[API错误：无可用渠道]」当故事发给副 API 去配图。
//
// 判定规则:
// ① 空回:trim 后为空(null/undefined 同样视为空回);
// ② API 错误文本,两级匹配:
//    头部规则——正文以 [api…] 类诊断标记开头:允许 BOM/空白/markdown 引用与加粗噪声前缀、
//              括号内最多 200 字符补充说明([API Error: rate limit]、[API错误：无可用渠道])、
//              以及流式截断导致的未闭合括号;
//    内联规则——不超过 256 字符的短正文任意位置出现完整闭合标记
//              (覆盖「流式先吐部分内容、上游随后报错」);长文不启用以防虚构叙事误判;
// ③ 其余 → 正常。

/** 头部诊断标记:允许噪声前缀与括号内补充信息;闭括号可省略(流式截断)。 */
const API_ERROR_HEAD_PATTERN =
  /^[\s\uFEFF>*_]*[【\[]\s*(?:api|接口)\s*(?:错误|异常|error|fail(?:ed|ure)?)(?:[^\]】]{0,200}[】\]])?/iu;
/** 内联诊断标记:必须完整闭合;仅对短正文启用。 */
const API_ERROR_INLINE_PATTERN =
  /[【\[]\s*(?:api|接口)\s*(?:错误|异常|error|fail(?:ed|ure)?)[^\]】]{0,200}[】\]]/iu;
/** 内联规则适用的正文长度上限。 */
export const INLINE_TRIAGE_MAX_LEN = 256;
/** 摘录截断长度。 */
export const TRIAGE_DETAIL_MAX_LEN = 500;

export type ResponseTriageKind = 'ok' | 'empty' | 'api_error';

export interface ResponseTriage {
  kind: ResponseTriageKind;
  /** kind='api_error' 时为错误正文摘录;其余为 null。 */
  detail: string | null;
}

/**
 * 对一段助手回复文本做三分类判定。
 * 空回与 API 错误互斥且优先级明确:非空才可能命中错误标记;命中标记即不再视为空回。
 */
export function triageAssistantText(text: string | null | undefined): ResponseTriage {
  const message = String(text ?? '').trim();
  if (!message) return { kind: 'empty', detail: null };
  const hitApiError =
    API_ERROR_HEAD_PATTERN.test(message) ||
    (message.length <= INLINE_TRIAGE_MAX_LEN && API_ERROR_INLINE_PATTERN.test(message));
  if (hitApiError) return { kind: 'api_error', detail: message.slice(0, TRIAGE_DETAIL_MAX_LEN) };
  return { kind: 'ok', detail: null };
}
