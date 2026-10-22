# e1auto HTTP API 参考

基础地址 `E1AUTO_URL`（默认 `http://127.0.0.1:8765`）。除 `/healthz` 外都要带请求头 `X-API-Key: <key>`。完整的自动生成文档：`<地址>/docs`（OpenAPI）。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 服务状态：`status`、`e1_host`、`workers`、`write_allowed` |
| GET | `/api/functions` | 功能清单：`name`、`title`、`description`、`menu`、`program`、`changes_data`、`params_schema` |
| GET | `/api/functions/{name}` | 单个功能 |
| GET | `/api/functions/{name}/template.xlsx` | Excel 模板（`Input` 页 + `说明` 页） |
| POST | `/api/functions/{name}/run?wait=true&timeout=600` | 单次运行，body `{"params": {...}}`；参数不合法直接 422，不排队 |
| POST | `/api/functions/{name}/batch?wait=false` | 上传 Excel：multipart 字段 `file`（.xlsx），可选 `dry_run`（true/false）、`stop_on_error`、`sheet` |
| GET | `/api/jobs` | 作业列表（新的在前） |
| GET | `/api/jobs/{id}?wait=true&timeout=60` | 作业详情；`wait=true` 时最多等 `timeout` 秒到作业结束 |
| POST | `/api/jobs/{id}/cancel` | 取消：排队中的立即取消，运行中的批量在当前行结束后停止 |
| GET | `/api/jobs/{id}/result.xlsx` | 批量的结果表 |
| GET | `/api/jobs/{id}/files.zip` | 作业全部文件（作业结束后才能下载，否则 409） |
| GET | `/api/jobs/{id}/files/{path}` | 单个文件（用作业详情 `links` 里的地址，已 URL 编码） |

错误码：401 Key 缺失或不对；404 功能 / 作业 / 文件不存在；409 作业还在跑；413 上传超过 20MB；422 参数不合法（`detail` 里逐项列出）。

## 作业对象

```json
{"id": "7f39ffbedc8b", "function": "ap.xts_dncn_attachments", "kind": "run", "state": "succeeded",
 "created_at": "...", "started_at": "...", "finished_at": "...",
 "progress": {"done": 0, "total": 0},
 "result": {"status": "ok", "message": "下载 3/3 个附件",
            "data": {"rows": 3, "file_count": 3, "file_names": ["DCN-AABOD26003-001__....xlsx"]},
            "files": ["/app/jobs/.../attachments.xlsx"], "screenshots": []},
 "error": null,
 "links": ["/api/jobs/7f39ffbedc8b/files/attachments.xlsx"]}
```

- 单次作业的 `result` 是功能结果（`status` 见 SKILL.md 第 4 节）。
- 批量作业的 `result` 是汇总：`total`、`succeeded`、`failed`、`resumed`、`counts`、`result_path`；逐行结果在 `result.xlsx`。
- `result.files` 是服务器内部路径，下载请用 `links` 或 `files.zip`。

## curl 示例

```bash
KEY=...           # 不要写进文件
URL=http://127.0.0.1:8765

curl -s $URL/healthz
curl -s -H "X-API-Key: $KEY" $URL/api/functions

# 单次运行并等待
curl -s -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -X POST "$URL/api/functions/ap.xts_dncn_attachments/run?wait=true" \
     -d '{"params": {"dncn_no": "AABOD26003"}}'

# 凭单试运行（真实提交要用户确认后加 "dry_run": false）
curl -s -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
     -X POST "$URL/api/functions/ap.standard_voucher_entry/run?wait=true" -d @voucher.json   # voucher.json = {"params": {...}}

# 上传 Excel 批量，然后轮询
curl -s -H "X-API-Key: $KEY" -F "file=@dncn.xlsx" "$URL/api/functions/ap.xts_dncn_attachments/batch"
curl -s -H "X-API-Key: $KEY" "$URL/api/jobs/<id>?wait=true&timeout=60"

# 下载
curl -s -H "X-API-Key: $KEY" -o result.xlsx "$URL/api/jobs/<id>/result.xlsx"
curl -s -H "X-API-Key: $KEY" -o files.zip "$URL/api/jobs/<id>/files.zip"
```

PowerShell 7：

```powershell
$h = @{ "X-API-Key" = $env:E1AUTO_API_KEY }
Invoke-RestMethod -Method Post -Headers $h -ContentType "application/json" `
  -Uri "http://127.0.0.1:8765/api/functions/ap.xts_dncn_attachments/run?wait=true" `
  -Body '{"params": {"dncn_no": "AABOD26003"}}'
Invoke-RestMethod -Method Post -Headers $h -Form @{ file = Get-Item .\dncn.xlsx } `
  -Uri "http://127.0.0.1:8765/api/functions/ap.xts_dncn_attachments/batch"
```
