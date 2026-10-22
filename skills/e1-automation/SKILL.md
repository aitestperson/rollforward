---
name: e1-automation
description: Operate LF's JD Edwards E1 (EnterpriseOne) through the e1auto HTTP API - download XTS DN/CN attachments, enter AP vouchers (Standard Voucher Entry, dry run first), export Supplier Ledger Inquiry, or run any registered E1 menu function once or for every row of an Excel sheet. Use when the user asks to look up, download, export or enter data in E1 / JDE / EnterpriseOne, e.g. "下载 XTS DN/CN 附件", "录入凭单", "查供应商分类账", "按 Excel 批量查询下载或录入". Calls the REST service (default http://127.0.0.1:8765, header X-API-Key) and ships a dependency-free Python client, scripts/e1api.py.
---

# E1 Automation（e1auto HTTP API）

E1 的菜单功能被包装成了 HTTP 接口：服务（Docker 容器 `e1auto`）用无界面浏览器替人登录 E1 UAT、打开菜单、填条件或填表、拿回结果和文件。你只需要调接口，不需要碰浏览器。

## 1. 连接

- **地址**：环境变量 `E1AUTO_URL`，默认 `http://127.0.0.1:8765`（本机 Docker）。在别的容器里通常是 `http://host.docker.internal:8765`，别的机器用服务所在机器的地址。
- **认证**：每个 `/api/...` 请求带请求头 `X-API-Key`，值来自环境变量 `E1AUTO_API_KEY`。本机没设置时，`scripts/e1api.py` 会自动读取 `C:\Users\v-GodtreeGao\files\ai_project\e1_automation\.env` 里的 `E1_API_KEY`。**不要把 Key 写进回复、日志或文件。**
- **先检查服务**：

  ```bash
  python scripts/e1api.py health
  # {"status": "ok", "e1_host": "e1.lfuat.net", "write_allowed": false, ...}
  ```

  连不上（exit code 3）：在项目目录 `C:\Users\v-GodtreeGao\files\ai_project\e1_automation` 执行 `docker compose up -d`，再查一次。

`scripts/e1api.py` 只用 Python 标准库，所有命令都输出 JSON；退出码 0 = 成功，1 = 作业没成功（看 `result.status`），2 = 接口报错（401 Key 不对、404 没这个功能 / 作业、422 参数不对），3 = 服务连不上。没有 Python 的环境用 curl，见 `references/api.md`。

> 脚本路径相对于本 skill 目录：Claude Code 是 `~/.claude/skills/e1-automation/scripts/e1api.py`，Codex 是 `~/.codex/skills/e1-automation/scripts/e1api.py`（源文件在项目的 `skills/e1-automation/`）。下文的 `scripts/e1api.py` 都指这个文件。

## 2. 先看有哪些功能、要什么参数

```bash
python scripts/e1api.py functions                          # 功能清单
python scripts/e1api.py describe ap.xts_dncn_attachments   # 参数的 JSON Schema（以它为准）
```

新增的菜单功能会自动出现在清单里，不要假设只有下面这几个。目前有：

| name | 做什么 | 会写数据 |
|---|---|---|
| `ap.xts_dncn_attachments` | 按 DN/CN 号（`dncn_no`，如 `AABOD26003`）等查 XTS DN/CN 附件，导出清单并下载附件 | 否 |
| `ap.standard_voucher_entry` | 录入 AP 凭单：表头 + `pay_items` + `gl_lines` | **是**（默认 `dry_run=true`） |
| `ap.supplier_ledger_inquiry` | 按供应商（必填）查 AP 凭单并导出 Excel | 否 |

## 3. 常用流程

### A. 单次运行

```bash
python scripts/e1api.py run ap.xts_dncn_attachments --params '{"dncn_no": "AABOD26003"}' --download ./e1_out
```

- 默认等到作业结束（长轮询）。结果看 `result.status`、`result.message`、`result.data`；`--download DIR` 把这次作业的所有文件解压到本机目录，路径列在 `downloaded` 里。
- 参数多时写进文件：`--params-file params.json`。
- 不想等：`--no-wait`，之后 `job <id> --wait`、`download <id> <dir>`。

### B. 按 Excel 批量（财务最常见的用法）

1. 拿模板：`python scripts/e1api.py template ap.standard_voucher_entry 模板.xlsx`（"说明"页写着每一列的含义）。用户自己的 Excel 也行：列名按参数标题匹配，大小写、空格、标点不敏感，多余的列原样保留。
2. 提交：`python scripts/e1api.py batch ap.xts_dncn_attachments 清单.xlsx --download ./e1_out`
3. 结果：`result.xlsx` = 原表 + `E1 Status` / `E1 Message` / 输出列（附件数、文件名、凭单号、批号…）；文件按行放在 `rows/<行号>_<关键字>/`。
4. 续跑：把 `result.xlsx` 再提交一次，已成功的行自动跳过。

### C. 录入凭单（会写 E1 数据，必须照做）

1. **永远先试运行**（不传 `dry_run` 就是试运行），看到 `validated` 才算通过；`refused` 时把 E1 原文告诉用户。
2. **只有用户明确同意后**才真实提交：单次在参数里加 `"dry_run": false`；批量加 `--commit`（把试运行的 `result.xlsx` 直接提交即可）。服务端还要求 `E1_ALLOW_WRITE=true`，并且只在 UAT（`e1.lfuat.net`）允许写入，PROD 一律拒绝。
3. 参数示例：

   ```json
   {"company": "00001", "supplier_number": "876414", "business_unit": "001901601",
    "invoice_number": "INV-0001", "invoice_date": "2025-12-31", "gl_date": "2025-12-31",
    "pay_items": [{"gross_amount": "1.00", "remark": "..."}],
    "gl_lines": [{"account_number": "001901601.7311", "amount": "1.00"}]}
   ```

   分录合计必须等于付款项合计；**尽量填发票号**（用来查重，防止重复录入）。批量时一行一条 G/L 分录，同一 `Voucher Key` 的多行是一张凭单。
4. `needs_attention`：凭单可能已在 E1 建立（结果里有批号 / 单号），**不要重跑**，把单号交给用户去 Supplier Ledger Inquiry 核对。
5. E1 的警告默认不自动接受（会变成 `refused` 并带警告原文）；要接受得由用户决定后传 `"accept_warnings": true`。

## 4. 结果怎么看

| `result.status` | 含义 | 你该做什么 |
|---|---|---|
| `ok` | 完成 | 汇报结果 / 文件 |
| `no_data` | 没查到 | 如实告诉用户，核对条件 |
| `validated` | 试运行通过，未保存 | 问用户是否真实提交 |
| `skipped` | 已存在（如同一发票已有凭单） | 告诉用户已有的单号 |
| `refused` | E1 或写入保护拒绝，`message` 是原文 | 转告原文；**不要换着参数乱试** |
| `needs_attention` | 做了一半，需要人处理 | 不要重跑，交给用户 |
| `invalid` | 参数不合法，没碰 E1 | 按 `message` 改参数 |
| `error` | 程序故障（可能附截图链接） | 可以重试一次；再失败就报告 |

作业 `state`：`succeeded`（单次成功 / 批量全部成功）、`partial`（批量部分失败）、`failed`、`cancelled`。

## 5. 规则

- 查询类功能必须给至少一个真正的条件（空白、`*` 不算），服务会拒绝无条件查询。
- 同一时间服务只跑一个作业（排队），不要并发狂发请求；一次查询附件太多（默认 > 200）会只给清单不下载。
- 下载到的文件是业务数据：放在用户指定的目录，不要上传到别处。
- 遇到 401 先检查 Key；遇到"服务连不上"先 `docker compose up -d`；不要自己去改 E1 账号或 `.env` 里的写入开关。

## 6. 新增一个菜单功能（开发者 agent）

在项目目录执行 `uv run python -m e1auto explore "LF Menus > … > 功能名"`，它会扫描画面并生成插件草稿；放进 `e1auto/functions/` 后 `docker compose up -d --build`，新功能就会出现在 `functions` 里。细节见项目 `README.md`。
