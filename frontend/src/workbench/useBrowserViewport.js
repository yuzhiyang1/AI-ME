import { useLayoutEffect } from "react";

/** 原生页面在 DOM 上层，任何模态遮罩/菜单出现时必须主动撤下，而非只提高 z-index。 */
const overlaySelector = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="dialog-overlay"], [data-slot="alert-dialog-overlay"], [data-slot="popover-content"]';
function isOverlayVisible() {
  return [...document.querySelectorAll(overlaySelector)].some((node) => {
    const style = getComputedStyle(node);
    return !node.hidden && style.display !== "none" && style.visibility !== "hidden";
  });
}

export function useBrowserViewport(browser, sessionId, surface, onError) {
  useLayoutEffect(() => {
    let frame;
    let lastRect;
    let active = true;
    let overlayVisible = isOverlayVisible();
    const send = (rect) => {
      const key = JSON.stringify(rect);
      if (key === lastRect) return;
      lastRect = key;
      try { Promise.resolve(browser.setViewport({ sessionId, rect })).catch(onError); }
      catch (error) { onError(error); }
    };
    const measure = () => {
      if (!active) return;
      const element = surface.current;
      // 首次导航也需要 viewport 资格；是否显示已有页面由主进程决定。
      if (!element || document.hidden || overlayVisible) { send(null); return; }
      const box = element.getBoundingClientRect();
      const x = Math.max(0, Math.ceil(box.left));
      const y = Math.max(0, Math.ceil(box.top));
      const width = Math.max(0, Math.floor(Math.min(window.innerWidth, box.right)) - x);
      const height = Math.max(0, Math.floor(Math.min(window.innerHeight, box.bottom)) - y);
      // rect 使用 CSS 像素；Electron 负责转换缩放后的窗口坐标，不能乘 devicePixelRatio。
      send(width && height && element.getClientRects().length ? { x, y, width, height } : null);
    };
    const schedule = () => measure();
    const resize = new ResizeObserver(schedule);
    if (surface.current) resize.observe(surface.current);
    // DOM 插入发生后立即隐藏，防止等下一帧时原生层盖住对话框。
    const mutations = new MutationObserver(() => { overlayVisible = isOverlayVisible(); schedule(); });
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["hidden", "style", "class", "open", "data-state", "data-open", "data-closed"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", measure);
    measure();
    // 分栏动画会改变位置而不改变尺寸；逐帧比较，仅坐标变化时发送 IPC。
    const track = () => { measure(); if (active) frame = requestAnimationFrame(track); };
    frame = requestAnimationFrame(track);
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", measure);
      send(null);
    };
  }, [browser, sessionId, surface, onError]);
}
