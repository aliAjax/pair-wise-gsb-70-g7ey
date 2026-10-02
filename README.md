# API 契约兼容性审查与版本发布平台

用于后端维护者、接口评审人和调用方负责人协作处理 API 契约变化的独立前端工程。工程没有真实后端，首次运行加载本地模拟契约，后续状态写入浏览器 `localStorage`。

## 技术栈

- React 19 + TypeScript + Vite 8
- shadcn/ui 风格本地组件 + Radix UI primitives
- Zustand + persist
- TanStack Router
- TanStack Query
- Monaco Editor / Diff Editor
- Tailwind CSS 4

## 功能

- OpenAPI JSON 导入、契约列表搜索和领域/状态筛选
- 字段新增、删除、可选性、枚举与错误码变化展示
- 自动判定兼容、警告或不兼容，并要求调用方影响说明与迁移方案
- Monaco Editor 编辑契约定义，Monaco Diff Editor 比较正式版本快照
- 调用方列表、示例请求生成、逐条接受、退回和兼容层豁免
- 跨契约批量评审、发布门禁、正式版本冻结与版本历史
- Markdown 变更报告与 JSON 导出

## 可恢复的发布流程

- 每份契约带单调递增的**修订号** `revision` 与**依据版本** `basisVersion`；
  每次保存都必须提交打开时看到的修订坐标（乐观锁）。
- 两个标签页同时提交时，只接收基于当前修订的改动；落后方收到冲突，
  先在对话框中查看对方变更的字段、作者、修订和值，再基于最新内容合并重提。
- 冻结时把变更、调用方、豁免、校验值与修订号深拷贝固化进版本快照；
  冻结后这些内容只读，旧草稿不能再过发布门禁，只能「基于冻结版本开启新草稿」。
- 每次提交带幂等 `operationId`；写入失败时操作进入**待恢复批次**，
  重试不会重复生成版本或豁免。
- 旧数据首次打开自动迁移：补齐修订号、审核依据（变更/豁免）和冻结快照，
  历史冻结版本标记为 `legacy`（只展示、不参与校验值验签）。
- 页面、发布门禁与变更报告统一通过 `effectiveView()` 取同一有效版本：
  已冻结取固化快照，否则取当前修订工作副本。

## 运行

```bash
npm install
npm run dev
```

默认开发地址为 `http://localhost:18470`。

生产构建：

```bash
npm run build
```

构建输出位于 `dist`。

## 目录

```text
src/
  components/             shadcn/Radix 基础组件、业务组件、应用外壳
  data/                   本地模拟契约
  lib/                    通用工具
  models/                 契约模型、兼容性与发布门禁规则
  pages/                  工作台、详情、批量评审、发布、报告
  services/               本地持久化服务和 TanStack Query hooks
  store/                  Zustand 评审工作区状态
```
