# 実機確認メモ（Claude Code 2.1.310 / 2026-11-12）

spec §6.2「重要」、§12 Integration 8、§13 Phase 1 の Go/No-Go を確認した結果。
採取したペイロードは個人情報・ID・パスを置換して `tests/fixtures/{hooks,otlp}` に保存している。

## 手順

1. `scripts/capture/receiver.mjs <outdir>` を `127.0.0.1:43999` で起動（OTLP/HTTP JSON をファイルへ保存）。
2. `--settings` で exec form（`command` + `args`）の Hook を一時追加し、`scripts/capture/hook.mjs` が stdin を保存する。
3. `scripts` に `test:unit`（成功）と `fail`（exit 3）だけを持つ一時プロジェクトで
   `claude -p` に `npm test` → `npm run fail` → `npm run test:unit` を順に実行させる。
   OTel 環境変数は spec §6.1 と同じ値（`OTEL_LOG_*=0`）を使う。

## 結果

| 項目 | 結果 |
|---|---|
| Hook exec form（`command` + `args`） | 動作する |
| 非ゼロ終了（`npm test` の Missing script、`npm run fail` の exit 3） | **`PostToolUseFailure`** に出る。`PostToolUse` には出ない |
| `PostToolUseFailure.error` | `"Exit code <N>\n<stderr/stdout>"` 形式の文字列。`is_interrupt` と `duration_ms` が付く。`tool_response` はない |
| 正常終了 | `PostToolUse`。`tool_response` は `{stdout, stderr, interrupted, isImage, noOutputExpected}` で、終了コードのフィールドはない |
| `prompt_id` | Hook 入力に含まれる（SessionStart にはない） |
| OTel `claude_code.tool_result` | `tool_use_id`、`success`（`"true"`/`"false"`）、`duration_ms`（文字列）、`error_type`（例：`ShellError`）、`prompt.id`、`event.sequence` を持つ |
| **`tool_use_id` での相関（Go/No-Go）** | **Go**：Hook と OTel の `tool_use_id` が完全に一致した |
| OTLP 認証ヘッダー | `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>` は `authorization: Bearer <token>` として届く |
| メトリクス | `claude_code.session.count` / `token.usage` / `cost.usage` / `active_time.total` は `sum`、`aggregationTemporality=1`（DELTA） |
| OTel の個人属性 | `user.email`、`user.id`、`user.account_uuid`、`user.account_id`、`organization.id` が全レコードに付く。**取り込み時に必ず捨てる** |

## 実装への反映

- 成功判定：`PostToolUse` かつ `tool_response.interrupted !== true` の場合だけ `success` にする。それ以外の形は `unknown`。
- 失敗判定：`PostToolUseFailure` かつ `is_interrupt !== true` の場合を `failure` にする。中断は学習対象外。
- Missing script 分類は `error` 文字列から行い、全文は保存しない。
- OTLP は allowlist 属性（`event.name`、`session.id`、`prompt.id`、`event.sequence`、`tool_name`、`tool_use_id`、`success`、`duration_ms`、`error_type`）だけを読む。
