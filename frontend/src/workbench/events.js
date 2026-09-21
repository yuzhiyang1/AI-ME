/** 将 AI-ME 本地事件转换为 ZCode RPC 的可释放订阅；卸载后不保留监听器。 */
export function createEvent() {
  const listeners = new Set();
  return {
    listen(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    },
  };
}

/** 未适配接口必须失败，不能靠返回空对象伪装成功。事件只保留订阅语义。 */
export function serviceBoundary(name, implementation = {}) {
  const events = new Map();
  return new Proxy(implementation, {
    get(target, method) {
      if (method in target) return target[method];
      if (typeof method !== "string" || method === "then") return undefined;
      if (method.startsWith("on")) {
        if (!events.has(method)) events.set(method, createEvent());
        const event = events.get(method);
        return method.startsWith("onDynamic")
          ? () => event.listen
          : event.listen;
      }
      return async () => {
        throw new Error(`AI-ME 尚未接入：${name}.${method}`);
      };
    },
  });
}
