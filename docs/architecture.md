# AI-ME 架构说明

## 目标

AI-ME 采用客户端优先的模块化单体。DDD 用于表达领域规则，洋葱架构用于控制依赖方向；两者都不要求微服务。

```text
Electron 客户端（默认入口） ─┐
                            ├─> React 共享渲染层 ─> 本地 FastAPI
未来远程 Web（保留入口） ───┘                        │
                                                    v
presentation -> application -> domain <── infrastructure
```

## 客户端优先边界

- `desktop` 是当前的默认启动和使用入口，负责原生窗口、桌面安全边界及本地进程编排。
- `frontend` 是共享 React 渲染层，不等于产品必须以浏览器运行。
- `backend` 默认仅监听本机地址，承载 Agent、SOP、证据、审批和工具调用等核心能力。
- Web 入口暂不作为正式交付面；未来需要远程访问时，再补充认证、授权、TLS、部署和远程密钥管理。
- Electron 预加载桥保持窄接口，渲染层不直接获得 Node.js 或系统权限。

## 各层职责

- `domain`：实体、值对象、聚合、领域服务、领域事件和仓储端口。
- `application`：用例编排，以及 Agent Runtime、事件发布等应用端口。
- `infrastructure`：数据库、LLM、MCP、日志平台、Git 和消息渠道的适配器。
- `presentation`：本地 HTTP、WebSocket、CLI，以及未来远程 Web 等输入输出协议。
- `composition.py`：唯一知道所有具体类型的装配根。

## 当前纵向切片

仓库只提供一个最小的 `WorkItem` 示例，用来证明完整路径可以运行：

```text
HTTP -> CreateWorkItem -> WorkItem -> WorkItemRepository
```

它不是最终产品功能集合。新增 Agent Run、SOP、审批、证据等能力时，继续按同样方式完成纵向切片。

## 模型适配层切片

第二个纵向切片是模型适配层：`HTTP -> 应用用例 -> ModelGateway 端口 -> 协议适配器 -> 厂商 API`。厂商目录与传输协议解耦，协议细节只存在于基础设施层。详见 [模型适配层设计.md](模型适配层设计.md)。

## Agent Runtime 边界

应用层只认识 `AgentRuntime` 端口。后续由 AI-ME 自研 Python Runtime Kernel 实现模型调用、工具执行、审批与运行记录，领域层无需感知具体实现。

## 暂不引入

- 微服务、服务发现、API Gateway
- Kafka、分布式事务、Event Sourcing
- 公网部署、远程登录和多租户能力
- Python Runtime 的桌面安装包内置与自动升级
- 为未来场景预建大量空模块

当真实用例证明需要时，再引入对应基础设施。

