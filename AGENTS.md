# AI-ME 工程约定

- 使用中文编写面向维护者的说明与必要注释。
- 项目采用 Python 模块化单体，不为了架构形式拆分微服务。
- 依赖方向必须保持：`presentation -> application -> domain`。
- `infrastructure` 实现内层定义的端口，由 `composition.py` 完成装配。
- `domain` 不得依赖 FastAPI、Pydantic、SQLAlchemy、模型 SDK 或具体 Agent 框架。
- 新功能优先交付一个纵向切片：领域行为、应用用例、适配器、接口和测试一起完成。
- 前端沿用克制、简洁的工作台风格；紫色只用于品牌、主操作和选中状态。

