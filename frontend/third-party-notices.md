# Third-party notices

## ZCode

AI-ME 直接使用并适配 [ZCode](https://github.com/zai-org/ZCode) 的原版 UI 源码，版权所有：Copyright 2026 Z.AI Co., Ltd. 固定上游提交为 `872ad960de7ec172591f7e1952f7849229f94521`。

ZCode 以 Apache License 2.0 发布。原始许可证全文见：

- <https://github.com/zai-org/ZCode/blob/main/LICENSE>
- <https://www.apache.org/licenses/LICENSE-2.0>

原版 UI 及浏览器依赖位于 `frontend/vendor/zcode/`。许可证全文、NOTICE、第三方声明均原样保留；`frontend/public/third-party/zcode/` 的副本随 Vite 构建分发。AI-ME 不声明拥有上游商标，也不暗示本项目得到 Z.AI 的背书。

修改说明见 `frontend/vendor/zcode/UPSTREAM.md`。独立后端适配器位于 `frontend/src/workbench/`。之前的 `src/App.tsx`、`src/styles.css` 和 `zcode-design-tokens.css` 仍保留作迁移参考，已不再作为默认网页或桌面渲染入口。
