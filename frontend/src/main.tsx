import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// 与 Multica 桌面端一致，打包可变字体，避免依赖用户系统中并不存在的 Inter。
import "@fontsource-variable/inter";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

