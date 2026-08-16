/**
 * NAI 并发闸门。
 *
 * 为什么只有 NAI 需要:两个后端的排队模型不同——
 * - ComfyUI:POST /prompt 拿到 prompt_id 即入**服务端**队列,轮询各查各的 history,
 *   一次性全发出去由 ComfyUI 自己顺序执行。客户端再加队列纯属多余,还白拖慢。
 * - NAI:generate-image 是一次阻塞式 POST,等到图出来才返回,没有队列概念。
 *   并发几个就是几条连接同时压过去,容易吃 429(见 backends/nai.ts 的错误映射)。
 *
 * 故闸门只包 NAI,上限用户可调(默认 1)。ComfyUI 路径不经过这里。
 */

let limit = 1;
let running = 0;
/** 等待队列:先进先出,resolve 后拿到执行权。 */
const waiting: Array<() => void> = [];

/** 设置并发上限(1 起步)。调大时立刻放行等待中的任务。 */
export function setNaiConcurrency(value: number): void {
  limit = Math.max(1, Math.floor(value) || 1);
  pump();
}

function pump(): void {
  while (running < limit && waiting.length) {
    const next = waiting.shift();
    if (!next) break;
    running++;
    next();
  }
}

/**
 * 取得一个执行槽。返回 release 函数,**必须**在 finally 里调用,否则闸门泄漏。
 * signal 已取消时直接抛 AbortError,不占用槽位。
 */
export async function acquireNaiSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('已取消', 'AbortError');

  if (running < limit) {
    running++;
  } else {
    await new Promise<void>((resolve, reject) => {
      // 排队期间被取消:从队列摘除并抛错,不能让它之后还占一个槽
      const onAbort = () => {
        const index = waiting.indexOf(grant);
        if (index >= 0) waiting.splice(index, 1);
        reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
      };
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  let released = false;
  return () => {
    if (released) return; // 幂等:重复 release 不会把 running 减穿
    released = true;
    running--;
    pump();
  };
}

/** 当前是否需要排队(用于卡片显示「排队中」而非「生成中」)。 */
export function naiSlotBusy(): boolean {
  return running >= limit;
}

/** 测试用:复位闸门。放行(而非丢弃)等待者,避免遗留 promise 永挂。 */
export function resetNaiGate(): void {
  limit = 1;
  running = 0;
  const pending = waiting.splice(0, waiting.length);
  for (const grant of pending) grant();
}
