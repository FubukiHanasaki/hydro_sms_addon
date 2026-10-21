# Hydro SMS Addon

作者：**FubukiHanasaki** · AGPL-3.0-or-later · 当前版本：0.1.1

Hydro 原生学生信息管理插件。只使用 Hydro 账号登录，业务授权和学生资料保存在插件自己的 MongoDB 集合中，不运行 Python 服务，不依赖旧 SMS 数据库。

## 第一阶段功能

- `/sms` 学生档案面板：分页、姓名/学号搜索、状态筛选、新建和编辑。
- 学生基本资料、敏感联系资料、内部备注分开处理。
- 绑定/解绑已存在的 Hydro UID；同一 UID 只能关联一份学生档案。
- 在现有 Hydro 用户资料页中增加「学生资料」标签，后端按当前访问者过滤字段。
- 插件管理员通过面板追加或撤销指定 UID 的权限，支持全部学生或指定学生以及失效时间。
- 乐观锁避免并发覆盖；学号和 Hydro UID 唯一索引；敏感读取和写入审计。
- 复用 Hydro 默认主题的栅格、section、侧栏菜单、表格、表单和按钮；支持桌面、移动端及深色主题，资料弹窗内部滚动。

本阶段没有导入现有学生、Rating、班级或历史记录，也没有新建正式 Hydro 账号。Rating 将按「一个数值＋一个时间」的历史序列另行实现，不依赖旧考试和旧算法。

## 安装

要求 Node.js 22+、Hydro 5.0.7+、MongoDB 7+ 和 `@hydrooj/ui-default`。已在 Hydro 5.0.7 / UI 4.58.5 / MongoDB 8.0.16 下验证。当前使用默认 UI 的模板扩展点，尚未适配 `ui-next`。

在插件目录运行：

```bash
npm ci
npm run check
```

让运行 Hydro 的环境可以读取插件目录，然后注册绝对路径：

```bash
hydrooj addon add /absolute/path/to/hydro_sms_addon
```

重启 Hydro。配置中应保留 `@hydrooj/ui-default`。插件不需要额外网络端口。

使用独立 Hydro profile 时，请在该 profile 中注册插件，并按部署方式重启 Hydro 网站进程。

## 初始化管理员

**没有默认管理员，也不会继承 Hydro 超级管理员或域管理员权限。** 未指定插件管理员时，不允许创建档案或授权。按当前部署要求，正式环境暂不指定管理员，等待账户导入。

从服务器明确指定已存在的 Hydro UID：

```bash
node scripts/admin.cjs grant 123 /absolute/path/to/hydro/config.json
node scripts/admin.cjs list 0 /absolute/path/to/hydro/config.json
node scripts/admin.cjs revoke 123 /absolute/path/to/hydro/config.json
```

配置文件需包含 `uri` 或 `url`，示例中的 123 应替换为本人确认的 UID。CLI 不打印数据库凭据，拒绝撤销最后一名插件管理员。管理员任命和撤销均留痕。CLI 的执行者拥有服务器权限，应由服务器维护人员操作。

当前版本按单个 Hydro 实例管理一套学生档案，权限跨 Hydro 域一致；不是按域隔离的多机构版本。当前宿主用户查询使用标准、无前缀的 `user` 集合，暂不支持 Hydro 的自定义 collectionMap/prefix 配置。

## 权限规则

| 权限 | 能力 |
| --- | --- |
| `students.read` | 查看授权范围内的基本资料 |
| `students.sensitive` | 查看敏感资料和内部备注；编辑敏感资料还需要 `students.write` |
| `students.write` | 编辑授权范围内的基本资料 |
| `students.bind` | 修改档案对应的 Hydro UID |

追加授权必须包含 `students.read`。新建学生、管理授权和读取审计限插件管理员。当前每个被授权 UID 保存一组权限与学生范围；后续班级模块建立后再增加按班级授权。

绑定学生不需要追加授权即可查看自己的基本与联系资料，但不能因此编辑、绑定账号或查看内部备注。插件管理员若同时绑定自己的档案，也不能通过页面或接口读取本人内部备注。

账号绑定是一项高权限操作：绑定后会授予目标 UID 本人查看能力，请先核实账号归属。修改/解除绑定通过独立权限检查，不依据前端角色标签。

所有 API 从 Hydro 当前会话读取操作者，拒绝使用请求中的 UID 冒充操作者；页面不接收旧 SMS 会话。服务端不返回未授权字段，列表始终排除联系资料和内部备注，不把这些字段放入 `UiContext`。私有页面和接口使用 `Cache-Control: private, no-store`。

写请求使用同源 `Origin`、`X-SMS-Request: 1` 和 JSON Content-Type 校验；插件没有开放跨域接口。反向代理应按 Hydro 文档正确配置外部协议和 Host，否则同源写请求会被拒绝。

## 数据与一致性

- `sms_students`：UUID 主键、基本/敏感资料、内部备注、可选 Hydro UID、版本号与创建/更新操作者。
- `sms_policy`：单文档授权策略、管理员 UID、授权有效期与版本号。
- `sms_audit`：操作者、操作、对象、字段名称、时间和结果；不保存完整档案或敏感值。

资料和授权分别使用单文档原子更新与版本检查，因此本阶段不要求 MongoDB 副本集。以后涉及多实体强事务时，再引入副本集与事务。

写入先记录审计意图，再更新业务数据，最后标记结果。崩溃可能留下 `pending`（面板显示「待核对」），需要结合目标版本核对，不能据此自动重放写入。未实现跨集合强事务。授权在每次请求时重新读取，没有长期权限缓存。

资料编辑提交完整的基本资料分组；未获敏感权限的用户无法写入该分组。版本冲突返回 409，需重新打开档案后确认修改。当前没有硬删除、批量导出、自动迁移或学生自助修改功能。

## 目录与本地验证

```text
index.ts                Hydro 路由、用户资料页和导航接入
src/                    数据模型、鉴权、校验和业务服务
templates/              管理面板与用户资料页扩展
public/sms-addon/       原生 JavaScript 与 CSS
scripts/admin.cjs       服务器管理员初始化工具
.tmp/                   本地测试、截图、临时数据库、缓存和日志（Git 忽略）
```

`src/hydro.d.ts` 是本插件实际使用的窄宿主接口声明，避免把 Hydro 发布包及其依赖的 TypeScript 实现纳入本项目的严格检查。运行时仍使用真实 `hydrooj` 模块，声明不替代实际宿主联调。

按项目要求，本地回归代码和测试产物均放在 `.tmp`，不会随 Git 或 npm 包发布。在已准备本地测试脚本和隔离 MongoDB 的工作区可运行 `npm run test:local`；全新检出默认只提供 `npm run check`。浏览器测试使用独立 Hydro profile、临时账号和临时数据库，不能指向正式库。

不要将正式数据、数据库连接配置、学生导出文件、截图或会话凭据提交到 Git。`.gitignore` 已忽略 `.tmp/`、依赖、环境文件、数据库、CSV/Excel 和日志。

## 后续阶段

1. 确定学生字段与账号清单，建立迁移预览和显式 UID 绑定。
2. 导入学生基本资料及 Rating 时间序列，提供重复导入检查和结果核对。
3. 建立教师、班级与师生关系，再引入按班级范围授权。
4. 分步建设课次、排课、考勤和教学报表。
5. 接入 Hydro 作业、比赛与提交统计。

Copyright (C) 2026 FubukiHanasaki.
