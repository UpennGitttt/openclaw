# A股中线投资 × OpenClaw Agent 深度计划书（v1）

- 日期：2026-03-08
- 适用对象：`anthony`（A股中线投研与组合管理）
- 文档目标：把“资深投行经理的一天”拆成可执行的 Agent 工作流，并给出数据源、工具链、提示词、skills、md 文件结构、测试与风控方案。

---

## 1. 先定边界：这不是“预测系统”，是“决策支持系统”

### 1.1 业务目标（建议）

- 投资周期：2-12 周（中线）
- 目标：风险调整后收益优先（先控制回撤，再追求收益）
- 组合约束：
  - 单票仓位上限：10%-15%
  - 行业上限：30%-40%
  - 组合最大回撤预警：8%，硬阈值：12%
  - 杠杆：默认不用

### 1.2 合规与制度基线（必须内嵌到 Agent 规则）

- 程序化交易监管总纲：证监会《证券市场程序化交易管理规定（试行）》，2024-05-15 发布，2024-10-08 实施。
- 交易所细则：
  - 上交所实施细则：2025-04-03 发布，2025-07-07 实施。
  - 深交所实施细则：2025-04-03 发布，2025-07-07 实施。
- 信息披露主规：证监会令第226号《上市公司信息披露管理办法》，2025-03-26 发布，2025-07-01 起施行。
- 交易成本：证券交易印花税减半政策（财政部 税务总局公告2023年第39号），自 2023-08-28 起执行。
- 结算节奏参考：中国结算通知中明确“仅属 T+1 交收的交易品种”等安排。

> 结论：Agent 输出必须把“规则变化日期”写清楚，不能只写“最近/最新”。

---

## 2. 资深投行经理的一天：倒推 Agent 必备动作

## 2.1 08:00-09:00（开盘前）

- 动作：
  - 市场状态检查：指数趋势、成交额、北向资金、隔夜外盘扰动。
  - 组合风险扫描：是否触发止损、行业过度集中、事件风险。
  - 当日观察清单：持仓 + 候选池优先级。
- Agent 产物：`pre_open_brief.md`（结论/证据/动作/风险）

## 2.2 09:30-11:30 / 13:00-15:00（盘中）

- 动作：
  - 只做“触发条件监控”，不做临时拍脑袋改策略。
  - 跟踪关键阈值：价格、量能、异常波动、公告。
- Agent 产物：`intraday_alerts.md`（仅记录触发与处理建议）

## 2.3 15:00-17:00（收盘后）

- 动作：
  - 更新组合收益归因：市场 beta / 行业 / 选股 / 时点。
  - 更新持仓假设是否仍成立（ thesis check ）。
  - 生成 T+1 执行草案（不是直接下单）。
- Agent 产物：`post_close_review.md` + `t1_action_list.md`

## 2.4 周度（周末）

- 动作：
  - 失败案例复盘：错在信号、执行还是风控。
  - 候选池重排：剔除无催化、低流动性、高不确定性标的。
- Agent 产物：`weekly_committee_pack.md`

---

## 3. 数据与工具：按“可靠性分层”而不是“接口数量”

## 3.1 数据源分层

- L0（监管与交易所权威）：CSRC / SSE / SZSE / 中国结算 / 税务总局法规库
- L1（结构化行情与财务）：Tushare、AKShare
- L2（量化研究与回测框架）：Qlib、RQAlpha、vn.py、Backtrader、vectorbt、PyPortfolioOpt、FinRL
- L3（研究观点）：AQR / Research Affiliates / Alpha Architect

## 3.2 数据源角色建议（给 anthony）

- `get_stock_quote`：优先轻量、低延迟；失败时显式降级（并写 `degraded_mode=true`）
- `get_stock_history`：中线主数据（日线优先）
- `get_financial_*`：定期更新，不做盘中高频依赖
- `get_data_source_health`：所有股票类 cron 任务起步前先跑

## 3.3 工具 SLA（建议写入 TOOLS.md）

- 关键工具可用率（7日滚动）：>= 97%
- `quote` P95：< 8s
- `history` P95：< 10s
- 失败输出规范：必须返回 `{error, hint, source, fallback_used}`

---

## 4. OpenClaw 集成设计（Prompt / Skills / Tools / MD）

## 4.1 anthony 的系统提示词策略（建议）

- 目标：`systemPromptMode=replace`，将“中线投研流程”作为唯一执行主线。
- 核心规则（必须写死）：
  - 先证据后结论。
  - 无证据字段写 `N/A`。
  - 若工具失败，优先降级，仍失败则输出“不可决策”而不是编造。
  - 建议必须附带风险条件与失效条件。

### 4.1.1 System Prompt 骨架（可直接落地）

```text
你是A股中线组合经理助理，不是喊单机器人。
你的唯一目标是输出可执行、可复盘、可审计的决策支持。
流程固定为：健康检查 -> 数据收集 -> 证据表 -> 决策建议 -> 风险与失效条件。
任何数字必须来自工具返回；拿不到就写 N/A。
禁止主观臆测、禁止承诺收益、禁止省略风险条款。
```

## 4.2 Skills 设计（建议新增 6 个）

- `a-share-preopen-brief`
- `a-share-postclose-review`
- `portfolio-risk-check`
- `thesis-validity-check`
- `event-driven-watch`
- `weekly-investment-committee`

每个 skill 的 `SKILL.md` 固定结构：

- 输入参数
- 必调工具顺序
- 输出模板（结论/证据/动作/风险）
- 失败降级与停止条件

## 4.3 Tools 策略（三列表）

- `tools`：核心内置工具（read/exec/cron/message 等）
- `plugins`：akshare、memory_search、memory_get、feishu_xxx
- `mcp`：外部 MCP 能力（默认 deny，按需白名单）

建议：股票分析链路只开放最小工具集，避免误调用导致不稳定。

## 4.4 Workspace 文件架构（建议）

在 `~/.openclaw/agents/anthony/workspace` 追加：

- `STRATEGY.md`：策略目标、约束、可交易宇宙
- `RISK_POLICY.md`：仓位、回撤、止损、黑天鹅处理
- `SIGNAL_SCHEMA.md`：信号字段与评分逻辑
- `PORTFOLIO_RULES.md`：调仓规则、冲突处理优先级
- `REVIEW_TEMPLATE.md`：日/周复盘模板
- `RUNBOOK_INCIDENTS.md`：接口故障、数据异常、风控触发的处理手册

Memory 建议：

- `MEMORY.md`：长期原则与稳定偏好
- `memory/YYYY-MM-DD.md`：每日事实日志
- `memory/holdings.md`：持仓真相（唯一事实源）
- `memory/push_history.md`：对外推送留痕

---

## 5. “优秀来源项目”优先级清单（A股适配视角）

## 5.1 第一梯队（建议优先引入）

- AKShare：A股接口覆盖广，与你当前链路兼容。
- Tushare Pro：结构化与稳定性更适合生产日频。
- Qlib：研究到生产的完整框架，适合做因子与模型迭代。
- vn.py：若后续走实盘执行/交易网关，扩展价值高。

## 5.2 第二梯队（按阶段引入）

- RQAlpha：经典中文量化回测框架，适合策略验证。
- Backtrader / vectorbt：快速原型与策略对比。
- PyPortfolioOpt：组合优化（约束优化、风险平价等）。
- FinRL：强化学习路线探索（仅限研究，不建议直接上生产）。

## 5.3 不建议现在重投入

- 任何“黑盒荐股 API”或无审计链路的数据源。
- 无长期维护、文档薄弱、更新停滞项目。

---

## 6. “优秀书籍 / 网站 / 博客”深度清单（按用途分层）

## 6.1 书籍（方法论与工程）

- _Machine Learning for Asset Managers_（Cambridge, 2020）
- _Advances in Financial Machine Learning_（Wiley, 2018）
- _Algorithmic Trading_（Ernie Chan, Wiley, 2013）
- _Python for Algorithmic Trading_（O’Reilly）

## 6.2 A股制度与数据权威站点

- CSRC（规则与监管）
- SSE / SZSE（交易所规则、公告、指引）
- 中国结算（清算交收安排）
- 国家税务总局政策法规库（税费政策）
- 巨潮资讯网（法定披露平台入口由深证信提供）

## 6.3 研究网站/博客（策略研究与风险框架）

- AQR Research
- Research Affiliates Insights
- Alpha Architect Blog

---

## 7. 90天落地路线图（可直接执行）

## 阶段A（第1-2周）：稳定性优先

- 固化 `quote/history/health` 三条关键链路。
- 建立失败分类：网络/限流/源异常/解析失败。
- 给每条工具调用打上 `source`, `latency`, `fallback_used`。

## 阶段B（第3-6周）：决策流程固化

- 上线开盘前、收盘后、周度三套模板任务。
- 实装 `RISK_POLICY.md` 与阈值触发规则。
- 打通“结论 -> 行动 -> 复盘”的闭环记录。

## 阶段C（第7-10周）：组合与归因

- 引入组合约束与候选池打分。
- 日/周收益归因（beta、行业、选股、择时）。
- 形成稳定的 `weekly_committee_pack.md`。

## 阶段D（第11-13周）：验证与扩展

- 回测-实盘偏差分析（slippage/cost/regime shift）。
- 决策一致性审计（是否严格按流程运行）。
- 再评估是否引入 RL/更复杂模型。

---

## 8. 测试与风控（TDD 必做）

## 8.1 工具层测试

- 单元测试：参数校验、异常分类、fallback 分支。
- 集成测试：高峰时段、网络抖动、数据空值、超时。
- 回归测试：关键工具 100 次批量调用成功率。

## 8.2 决策层测试

- 模板一致性：输出是否总含“结论/证据/动作/风险”。
- 幻觉检测：数字字段必须能追溯到工具原始返回。
- 风险守卫：若数据不足，必须输出 `不可决策`。

## 8.3 运营层监控

- 日报：成功率、P95、降级率、不可决策率。
- 周报：策略命中率、误报率、回撤控制达标率。

---

## 9. 对你当前 anthony 的直接改造建议（最小可行）

1. 先不扩接口，先把 `quote/history/health` 做到高可用。
2. 把 `AGENTS.md` 的主流程改成“健康检查优先 + 证据表先行”。
3. 在 `TOOLS.md` 增加“失败分类与降级矩阵”。
4. 新增 `RISK_POLICY.md` 与 `SIGNAL_SCHEMA.md`，让输出从“描述”升级到“规则化决策”。
5. 先落地 2 个 cron：开盘前简报 + 收盘后复盘，跑满 2 周再扩。

---

## 10. 关键来源（高优先级）

### 监管与交易规则

- 证监会：程序化交易管理规定（试行）
  - https://www.csrc.gov.cn/csrc/c100028/c7480577/content.shtml
- 证监会令第226号：上市公司信息披露管理办法
  - https://www.csrc.gov.cn/csrc/c101953/c7547359/content.shtml
- 上交所：程序化交易管理实施细则
  - https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20250612_10781696.shtml
- 深交所：程序化交易管理实施细则发布通知
  - https://www.szse.cn/lawrules/rule/allrules/bussiness/t20250403_612770.html
- 深交所：实施细则答记者问
  - https://www.szse.cn/aboutus/trends/conference/t20250403_612773.html

### 税费与结算

- 国家税务总局政策法规库：公告2023年第39号（证券交易印花税减半）
  - https://fgk.chinatax.gov.cn/zcfgk/c102416/c5211343/content.html
- 中国结算：2025年节假日清算交收安排（含“T+1交收品种”表述）
  - https://www.chinaclear.cn/zdjs/gszb/202412/3e085db8506a47a9a8dfd35cf3d820c7.shtml

### 数据与量化项目

- AKShare 文档
  - https://akshare.akfamily.xyz/
- Tushare Pro 文档
  - https://tushare.pro/document/2
- Tushare GitHub
  - https://github.com/waditu/tushare
- Qlib GitHub
  - https://github.com/microsoft/qlib
- Qlib 文档
  - https://qlib.readthedocs.io/en/latest/
- vn.py GitHub
  - https://github.com/vnpy/vnpy
- RQAlpha GitHub
  - https://github.com/ricequant/rqalpha
- FinRL GitHub
  - https://github.com/AI4Finance-Foundation/FinRL
- Backtrader 文档
  - https://www.backtrader.com/docu/
- vectorbt 文档
  - https://vectorbt.dev/
- PyPortfolioOpt 文档
  - https://pyportfolioopt.readthedocs.io/en/latest/

### 信息披露与研究网站

- 深证信息（巨潮资讯网入口）
  - https://www.szsi.cn/cpfw/
- 上交所最新公告
  - https://www.sse.com.cn/disclosure/listedinfo/announcement/
- AQR Research
  - https://www.aqr.com/Insights/Research
- Research Affiliates Insights
  - https://www.researchaffiliates.com/insights
- Alpha Architect Blog
  - https://alphaarchitect.com/blog/

### 书籍（权威出版社）

- Cambridge: Machine Learning for Asset Managers
  - https://www.cambridge.org/core/elements/machine-learning-for-asset-managers/6D9211305EA2E425D33A9F38D0AE3545
- Wiley: Advances in Financial Machine Learning
  - https://www.wiley-vch.de/en/areas-interest/finance-economics-law/finance-investments-13fi/finance-investments-special-topics-13fiz/advances-in-financial-machine-learning-978-1-119-48208-6
- Wiley: Algorithmic Trading (Ernie Chan)
  - https://www.wiley-vch.de/en/areas-interest/finance-economics-law/algorithmic-trading-978-1-118-46014-6
- O’Reilly: Python for Algorithmic Trading
  - https://www.oreilly.com/library/view/python-for-algorithmic/9781492053347/

---

## 11. 下一步执行建议（按优先级）

1. 我先基于本计划，把 `anthony` 的 `AGENTS.md / TOOLS.md / CRON_STOCK_TEMPLATE.md` 输出一版“中线投研 v1”改造稿（不改代码，只改流程与模板）。
2. 然后做 `akshare` 工具链的 P0 稳定性重构方案（先 quote/history/health 三接口），按 TDD 出测试清单。
3. 最后再进入 2 周试运行：每天产出开盘前简报 + 收盘后复盘，验证成功率、延迟、可执行性。

---

## 12. 来源质量分级（防止“垃圾信息进系统”）

## 12.1 分级标准

- A 级：监管/交易所/结算机构/官方文档/头部开源仓库与官方文档。
- B 级：知名机构研究网站、出版社图书页。
- C 级：转载站、地方站、媒体二手摘要（仅用于交叉验证，不用于规则定稿）。

## 12.2 本计划采用规则

- 制度与交易规则：仅用 A 级。
- 模型与工程方法：A 级 + B 级。
- 观点类内容：只能作为“假设来源”，必须再用数据验证。

## 12.3 当前清单打分（节选）

- A级：CSRC / SSE / SZSE / 中国结算 / 国家税务总局法规库 / AKShare / Tushare / Qlib / vn.py / RQAlpha。
- B级：AQR / Research Affiliates / Alpha Architect / Cambridge / Wiley / O’Reilly。
- C级：政府或媒体转载页（仅用来补足官方站点偶发不可访问时的“文本复核”）。

---

## 13. OpenClaw 落地配置草案（anthony 专用）

## 13.1 配置原则

- Agent 优先：`agents.list[].tools.policy` 覆盖全局 `tools.policy`。
- system prompt 覆盖：`systemPromptMode: \"replace\"`。
- promptContext 文件清单固定，避免运行时漂移。

## 13.2 建议配置片段（示意）

```json
{
  "agents": {
    "list": [
      {
        "id": "anthony",
        "systemPromptMode": "replace",
        "promptContext": {
          "files": [
            "AGENTS.md",
            "SOUL.md",
            "TOOLS.md",
            "IDENTITY.md",
            "USER.md",
            "STRATEGY.md",
            "RISK_POLICY.md",
            "SIGNAL_SCHEMA.md",
            "PORTFOLIO_RULES.md",
            "REVIEW_TEMPLATE.md",
            "{MEMORY.md,memory.md}"
          ]
        },
        "tools": {
          "invoke": { "timeoutMs": 60000 },
          "policy": {
            "tools": { "allow": ["read", "exec", "cron", "message", "web_search", "web_fetch"] },
            "plugins": { "allow": ["akshare/*", "memory_search", "memory_get"] },
            "mcp": { "deny": ["*"] }
          }
        }
      }
    ]
  }
}
```

---

## 14. 提示词模板（可直接放到任务消息）

## 14.1 开盘前简报 Prompt

```text
任务：生成A股中线“开盘前简报”。
要求：
1) 先调用 get_data_source_health，若失败给出不可决策说明并停止。
2) 对持仓和候选池输出：结论、证据、动作、风险 四段。
3) 每个数字必须带来源字段；无法获取写 N/A。
4) 输出一个 T+1 观察清单（最多5只）。
```

## 14.2 收盘后复盘 Prompt

```text
任务：生成A股中线“收盘后复盘”。
要求：
1) 先更新持仓事实（价格、涨跌、仓位变化）。
2) 输出收益归因：市场/行业/选股/时点。
3) 对每个持仓给出 thesis 是否仍成立（Yes/No + 证据）。
4) 给出次日动作建议（保留/减仓/换仓/观察）。
```

## 14.3 周度投委会 Prompt

```text
任务：输出周度投委会材料。
要求：
1) 列出本周成功与失败案例各3条。
2) 失败案例必须给出规则修订建议。
3) 重排候选池并给出进入/剔除理由。
4) 生成下周风险地图（政策、财报、流动性、波动）。
```

---

## 15. Skills 文件建议（路径与最小骨架）

建议新增目录：

- `~/.openclaw/agents/anthony/workspace/.openclaw/skills/a-share-preopen-brief/SKILL.md`
- `~/.openclaw/agents/anthony/workspace/.openclaw/skills/a-share-postclose-review/SKILL.md`
- `~/.openclaw/agents/anthony/workspace/.openclaw/skills/portfolio-risk-check/SKILL.md`

每个 `SKILL.md` 至少包含：

- 适用场景
- 必调工具顺序
- 输出字段契约（JSON）
- 失败降级逻辑
- 终止条件（数据不足 -> `不可决策`）

---

## 16. 关键风险与防错清单

- 风险1：把“观点站”当“规则源”。
  - 防错：规则只允许 A 级来源。
- 风险2：工具失败后模型编造数字。
  - 防错：输出层强校验，数字必须带 source。
- 风险3：任务超时后重复调用造成雪崩。
  - 防错：全链路超时预算 + 幂等 runId + 降级优先。
- 风险4：策略漂移（每天逻辑都变）。
  - 防错：`STRATEGY.md/RISK_POLICY.md` 作为唯一真相源。
