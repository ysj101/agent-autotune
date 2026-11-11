# Agent AutoTune — MVP実装仕様書

- **Status**: Draft / MVP v0.1
- **Updated**: 2026-11-12
- **Target**: 個人開発、ローカルのClaude Code（macOS・Node.js LTS）
- **言語**: TypeScript
- **優先順位**: 品質・安全性 > ユーザーの待ち時間 > ツール再試行回数 > トークン/金銭コスト

## 0. 一言でいうと

**Claude Codeをいつもどおり使うだけで、プロジェクト固有のツール実行失敗から学習し、次回のセッションで小さな改善ヒントを自動提供し、効果がなければ安全に停止するローカルCLI。**

MVPでは「何でも最適化する」ことを目指さない。最初に完成させるのは、**存在しないnpm scriptを実行して失敗したケース**を検出し、対象プロジェクトの実在するscriptを根拠に、以後の無駄な実行を抑制する1本のエンドツーエンドループとする。

**ユーザーに同じタスクを再実行させない。** 同一タスクの比較実験を求めず、普段の開発中の異なるタスクから得た事実を再利用する。

## 1. 背景と課題

Claude Codeはその場のコマンド失敗を修正できるが、異なるセッションや日常タスクの間で「そのリポジトリ固有の失敗パターン」を継続的に計測・検証し、必要な情報だけを提供する専用ツールは価値を持ちうる。

例：

1. Claude Codeが`npm test`を実行し、`Missing script: "test"`で失敗する。
2. `package.json`に`test:unit`が定義されていると確認する。
3. 別のタイミングで`npm run test:unit`が成功する。
4. AutoTuneが**そのpackage.jsonの場所と内容のハッシュに紐づく検証済みヒント**を作る。
5. 後日の通常セッション開始時に「このパッケージのテストコマンドは`npm run test:unit`」を短く提示する。
6. package.json変更などで根拠が失われたら自動でヒントを無効化する。

品質の厳密な保証や、費用削減の因果効果を主張するものではない。MVPでは**検証可能な環境知識の再利用**を改善の定義にする。

## 2. ゴール / 非ゴール

### ゴール（Must）

- `init`を1回実行した後、ユーザーは通常の`claude`コマンドで作業できる。
- Claude Codeの**OpenTelemetry Logs/Metrics**と**Hooks**から実行イベントをローカル収集する。
- OTelの`tool_use_id`とHookの`tool_use_id`で同一ツール実行を関連付ける。欠損時も処理は継続する。
- 少なくとも1つの安全な自動改善ルールを実装する（R001）。
- ヒントの作成、活性化、検証、失効が**ユーザー操作を要求せず**行われる。
- 自動改善は**短い事実提示**に限定し、コマンドを勝手に書き換えたり実行したりしない。
- ユーザーは`status`、`rules`、`disable`、`enable`、`uninstall`で内容を把握・停止・撤去できる。
- 秘密情報やユーザーのプロンプト本文をデフォルト保存しない。外部サーバーへ送らない。
- AutoTuneの停止・異常時もClaude Codeの使用は妨げない（fail-open）。

### 非ゴール（Won't）

- 複数エージェントの統合、中央SaaS、チーム管理、クラウド同期。
- Codex、Cursor等への対応（アダプター拡張は将来）。
- トークン単位の自動モデル切替、Skill削除、プロンプト全文の書き換え。
- 自動的な`AGENTS.md`/`CLAUDE.md`書き換え、権限付与、ツール呼び出しのブロックや置換。
- 自律的なテスト再実行や「最適化のためだけ」のLLM呼び出し。
- Webダッシュボード、Jaeger/Grafana必須化、複雑なML/ベイズ最適化。
- 全タスクの品質・成功率の客観測定、恣意的なコスト削減率の算出。
- OpenTelemetryのベータ版Tracesへの必須依存（将来のオプション）。

## 3. ユーザーストーリー

| ID | Story | 完了条件 |
|---|---|---|
| US-01 | 一度セットアップすれば通常どおりClaude Codeを使いたい | `agent-autotune init`後、`claude`を直接起動してイベントが記録される |
| US-02 | 無駄な失敗を自動で学習してほしい | R001に合致する失敗と正しい実行が確認され、検証済みヒントが作られる |
| US-03 | 次回の作業に学習結果を活用したい | 適合プロジェクトの`SessionStart`で短いヒントが追加される |
| US-04 | 間違った学習による品質悪化を避けたい | 根拠ハッシュの不一致・矛盾検知で自動停止する |
| US-05 | 状況を簡単に確認したい | `status`/`rules`で適用内容と証拠が見える |
| US-06 | すぐに元に戻したい | `disable`/`uninstall`でコンテキスト注入と収集を停止できる |

## 4. 対応環境と依存

- **OS**: macOS（Apple Silicon/Intel）。初期版はWindows/Linux対象外。
- **Runtime**: 対象のOpenTelemetry JSがサポートするNode.js LTS。開発時はNode.js 24 LTSを基準にする。
- **Agent**: Claude Code CLI（既存インストールを利用）。HooksとOTelの対象バージョンを`doctor`で確認し、未対応機能には依存しない。
- **構成**: TypeScript CLI + ループバックHTTPサーバー + SQLite。永続デーモンはmacOSの`launchd`ユーザーサービスで管理。
- **依存**: SQLiteライブラリ（例:`better-sqlite3`）、JSON Schema検証（例:`zod`）、CLI引数処理（例:`commander`）、ローカルHTTP受信（Node標準`http`で十分）、テスト（例:`vitest`）。具体的なパッケージ版は実装時に互換性確認のうえロックする。
- **ネットワーク**: すべて`127.0.0.1`。外部送信・外部AI API呼び出しなし。

## 5. 全体構成

```text
通常操作: claude
    │
    ├─ Claude Code OTel Logs / Metrics
    │     └─ OTLP/HTTP JSON → 127.0.0.1:43181
    │                             └─ Ingest → Normalize → SQLite
    │
    └─ Claude Code Hooks（SessionStart / PostToolUse / PostToolUseFailure）
          └─ agent-autotune hook <event>（stdin JSON）
                ├─ イベントを最小情報に正規化 → ローカル受信機
                └─ SessionStartなら検証済みヒントを短文で返す
                                               │
                                  Analyzer / Rule Engine
                                               │
                                    Verified Hints Store
                                               │
                           変更・矛盾検出 → 自動失効 / 停止
```

### プロセス境界

- `agent-autotune daemon`: ローカルOTLP/Hookイベントの受信・SQLite保存・ルール評価。
- `agent-autotune hook`: Claude Codeから毎回呼ばれる**短命・低遅延**プロセス。受信機に接続できないときは何も出力せず終了コード0。
- `agent-autotune` CLI: セットアップ、状態確認、ルール制御。
- HookからCLIを呼ぶ経路はインストール時に絶対パスを解決し、`settings.json`内の既存Hooksと共存する。

**設計上の注意**: OTel Logs/MetricsはMVPの観測・分析基盤。コマンド文字列とエラー分類に必要な情報だけHooksから補完する。OpenTelemetry Traces（Claude Codeではbeta）は将来の追加対象とし、Trace IDが無くても動作させる。

## 6. データ収集仕様

### 6.1 Claude CodeのOpenTelemetry設定

`init`は既存設定を確認したうえで、`~/.claude/settings.json`の`env`に相当する設定を**キー単位でマージ**する。実際に加える例：

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
    "OTEL_LOGS_EXPORTER": "otlp",
    "OTEL_METRICS_EXPORTER": "otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
    "OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:43181",
    "OTEL_LOG_USER_PROMPTS": "0",
    "OTEL_LOG_ASSISTANT_RESPONSES": "0",
    "OTEL_LOG_TOOL_DETAILS": "0",
    "OTEL_LOG_TOOL_CONTENT": "0"
  }
}
```

- ユーザー・組織側のManaged設定、既存Exporter、信頼済みの別バックエンド設定が存在する場合、**黙って上書きしない**。互換性がない場合は`init`を停止して理由と回避方法を表示する。
- `init`は乱数生成した受信用トークンを`OTEL_EXPORTER_OTLP_HEADERS`（例：`Authorization=Bearer <generated-token>`）に設定する。値は画面に表示しない。既にこのキーが設定されている場合の競合もチェックする。
- **機密情報の保護**: OTelのプロンプト/応答/ツール詳細の収集を有効化しない。収集側も許可フィールドだけ取り込む。
- `OTEL_TRACES_EXPORTER=none`をデフォルトとし、beta traceは無効。既存の利用者設定があればそれを勝手に変更しない。
- `http/json`はローカルOTLP Receiver実装容易性のための選択。`/v1/logs`、`/v1/metrics`で標準OTLP JSONペイロードを受理する。未知フィールドは無視し、整形式のOTLPレスポンスを返す。
- 受信は`127.0.0.1:43181`に固定。ポート競合時は`init`失敗または設定と整合した別ポートに変更し、CLI/Hook/OTLPの3箇所を同時更新する。
- ローカルHTTPは他プロセスからアクセス可能なので、`init`時にローカルトークンを生成してヘッダー認証する。トークンはユーザー専用ファイル（権限0600）で保持し、HooksとOTLPの双方が送る。認証できないアクセスは拒否。トークンをログに出さない。

### 6.2 Hook設定

`init`は次のイベントをユーザースコープのHooksに追加する。他のHookエントリは壊さない。`command`は実際のインストール先の**絶対パス**、`args`は引数配列とする（shell解釈しないexec form）。

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "/ABS/PATH/agent-autotune", "args": ["hook", "SessionStart"], "timeout": 2 } ] }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/ABS/PATH/agent-autotune", "args": ["hook", "PostToolUse"], "timeout": 2 } ] }
    ],
    "PostToolUseFailure": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "/ABS/PATH/agent-autotune", "args": ["hook", "PostToolUseFailure"], "timeout": 2 } ] }
    ]
  }
}
```

**注**: Hook設定の`timeout`は**秒単位**（上記は2秒）。Hookが使えない環境では通常のClaude Code動作を優先する。終了コードは常に0を原則とし、Hook側の障害で操作をブロックしない。

- `SessionStart`: `session_id`, `cwd`から現在のプロジェクトとパッケージを特定する。検証済み・有効なヒントがあれば、`hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: "..."}`を返す。該当なしなら**stdoutを空にする**。
- `PostToolUse`: `tool_name=Bash`、`tool_use_id`、`cwd`、`tool_input.command`、`tool_response`を読み、**コマンドが正常終了したことを保守的に判定**できたケースだけ成功実行として記録する。
- `PostToolUseFailure`: 上記に加えて`error`、`is_interrupt`を取得。中断は学習対象から除外する。
- **重要**: コマンドの非ゼロ終了がどちらのイベント/結果表現で観測されるかはClaude Codeの実装・バージョンとツール応答に依存しうる。`PostToolUseFailure`だけを見て`npm test`の失敗を網羅したと仮定しない。両イベントに対する実機フィクスチャで検証し、判定できないものは`unknown`扱いとする。
- Hookには`permissionDecision`や`updatedInput`を返さない。Claude Codeの権限や実行コマンドは変更しない。

### 6.3 Event正規化・相関

収集する共通キー：

| Field | Source | Notes |
|---|---|---|
| `session_id` | Hook + OTel `session.id` | セッション識別 |
| `prompt_id` | Hook + OTel `prompt.id` | 無ければnull |
| `tool_use_id` | Hook + OTel `tool_use_id` | 最優先のjoinキー |
| `event_sequence` | OTel `event.sequence` | 同一プロセス内の順序。グローバル一意ではない |
| `project_root` | Hook `cwd`から解決 | ローカルDBのみ |
| `package_json_path` | 解析対象のパッケージ | 対象を混同しない |
| `kind` | `tool_started`/`tool_finished`/`otel_tool_result`など | 内部名 |
| `outcome` | `success`/`failure`/`unknown` | 未確定を成功扱いしない |
| `duration_ms` | OTel優先・Hook fallback | 無ければnull |
| `command_family` | Hook入力から分類 | 例：`npm_script` |
| `command_name` | 厳格allowlistで抽出 | 例：`test`、`test:unit` |
| `failure_code` | 分類済みエラー | 例：`NPM_MISSING_SCRIPT` |

- 相関優先順：`session_id + tool_use_id` → `session_id + prompt_id`で集計（同一実行と断定しない）→ 単独イベントとして保存。
- Hookが先、OTelが後から届いても、同一実行をupsertし二重計上しない。
- HookとOTelの成功判定が矛盾した場合は`unknown`に降格し、診断カウンターを増やす。
- OTel LogRecordの`attributes`、`resource`、`body`は標準OTLP JSON形式として読み、未知フィールドを無視する。
- メトリクスは日次のセッション数・トークン・コストを**利用可能な指標に限り**集計し、改善の自動判定に使わない。正確な値がない場合は`N/A`。
- 大きな生ペイロード、プロンプト本文、コマンドの機密引数、エラー全文、ソースコードはSQLiteに保存しない。

## 7. ルールエンジン（MVPはR001のみ）

### R001: npm missing-script correction

**目的**: 存在しないnpm scriptの呼び出し失敗を減らし、適切なscript名を次回以降のコンテキストに提供する。

**対象条件（全て必須）**:

1. `Bash`のコマンドが**単一の、シェル展開やパイプ・連結・リダイレクトのない**`npm test`または`npm run <script>`に一致する。`cd ... &&`など複合コマンドはMVPでは対象外。
2. npmの「Missing script」エラーとして分類可能、または対象の`package.json`にそのscriptが存在しないことが確認できる。
3. `cwd`または最も近い対象パッケージの`package.json`が安全に解決でき、JSONが正常に読める。
4. 代替候補のscriptが存在する（例：`test:unit`）。**候補は名前の類似だけで決定しない**。
5. その代替候補の`npm run <script>`が、同じパッケージで**実行成功した観測**がある。
6. 候補が一意である。複数ある場合は自動適用しない（`candidate`のまま）。
7. `package.json`の内容ハッシュが評価時点と注入時点で一致する。

**状態**:

```text
observed → candidate → verified → active → stale/disabled
                         └───────────────→ reverted
```

- `observed`: 誤ったscript実行を観測した。
- `candidate`: 既存`package.json`から候補を抽出した。
- `verified`: 同じパッケージで候補コマンドの成功実行を観測した。
- `active`: 次回SessionStartでヒントを付けられる。
- `stale`: 根拠のpackage.jsonが変更・削除された。即時注入停止。
- `disabled`: ユーザーが無効化した、または不正・矛盾が観測された。
- `reverted`: AutoTuneが適用したヒントを解除したことを履歴に記録。

**注入ヒント例**（機械生成した固定テンプレートを使い、モデルに自由文を生成させない）：

> [Agent AutoTune / verified project hint] このパッケージ（`./package.json`）に`test` scriptはありません。過去に`npm run test:unit`が成功しており、現行package.jsonにも存在します。テスト時はそのコマンドを検討してください。これは実行や権限の指示ではありません。

**注入制限**:

- 1セッション最大3ヒント、合計600文字以内。根拠のpathはプロジェクト相対に限定。
- 情報提供に限定し、`必ず実行`や`権限を上げる`など命令調を使わない。
- 同一sessionへ重複注入しない。`SessionStart`の`resume/compact`でも二重に出さないため、`session_id + hint_id + hint_revision`で履歴管理する。
- 注入前に必ず最新の`package.json`を再検証する。`cwd`配下以外に勝手にアクセスしない。シンボリックリンクで外へ出る対象は除外。

### 自動改善の評価

- **直接測定**: 同一パッケージで`Missing script`に分類された失敗回数、同一失敗の再発、ヒントの注入数、検証済みヒントの失効数、誤ヒント報告数。
- **補助測定**: Bash実行時間、ツール実行回数、OTelに存在するコスト/トークン量（傾向のみ）。
- 「ヒント後に失敗が減った＝ヒントが原因」とは結論しない。異なるタスクの比較には交絡がある。
- **自動停止条件**: 対象script削除、package.json変更、複数候補化、矛盾する観測、ユーザーの手動無効化。自動停止は**ヒントの注入停止**であってファイル内容のロールバックではない。
- セッションの結果が少なければ効果は`insufficient_data`と表示し、無理に有効判定しない。

## 8. ローカルデータモデル

SQLite、WALモード、`PRAGMA foreign_keys=ON`。タイムスタンプはUTC ISO 8601。DB schemaの最小構成：

```sql
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE tool_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tool_use_id TEXT,
  prompt_id TEXT,
  source TEXT NOT NULL,              -- hook / otel
  event_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  package_path TEXT,
  command_family TEXT,
  command_name TEXT,
  outcome TEXT NOT NULL,             -- success/failure/unknown
  failure_code TEXT,
  duration_ms INTEGER,
  UNIQUE(session_id, tool_use_id, source, event_type)
);

CREATE TABLE hints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  package_path TEXT NOT NULL,
  package_hash TEXT NOT NULL,
  failed_script TEXT NOT NULL,
  suggested_script TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  evidence_event_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invalidated_reason TEXT
);

CREATE TABLE hint_deliveries (
  session_id TEXT NOT NULL,
  hint_id TEXT NOT NULL REFERENCES hints(id),
  hint_version INTEGER NOT NULL,
  delivered_at TEXT NOT NULL,
  PRIMARY KEY (session_id, hint_id, hint_version)
);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL,
  object_id TEXT,
  reason_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
```

- `tool_events`の`source`違いによる同じツールの2レコードは許容し、集計時は`session_id + tool_use_id`で一意化する。`tool_use_id IS NULL`の場合、時間近接による推測joinは禁止。
- `tool_events`にヒントの原因・根拠となる分類済みフィールドだけを保持。コマンド全文は保存しない。
- `hints`は`(project_id, package_path, failed_script, suggested_script, package_hash)`で論理一意に扱う（必要ならユニークインデックス追加）。
- 注入イベントの保存が失敗したら注入しない（正確な重複抑制を優先）。
- 永続ストアは`~/.local/share/agent-autotune/agent-autotune.db`。設定/トークンは`~/.config/agent-autotune/`（権限0700/0600）。
- 保存期間は既定30日（`tool_events`）、ヒント・監査履歴は90日。`agent-autotune purge`で全データ削除可能。

## 9. CLIインターフェース

```text
agent-autotune init             # daemon・OTel・Hooksを安全に登録
agent-autotune doctor           # バージョン、port、Hooks、OTel、DBを診断
agent-autotune status           # 稼働状態、観測件数、activeヒント、効果指標
agent-autotune rules            # ヒント一覧、根拠と状態
agent-autotune disable         # 注入と記録を停止（設定は保持）
agent-autotune enable          # 再開
agent-autotune disable --rule <id>  # 特定ヒントのみ無効化
agent-autotune purge           # ローカル保存データを削除（確認あり）
agent-autotune uninstall       # AutoTuneが追加した設定とdaemonだけ撤去
agent-autotune daemon          # launchdが起動する内部サブコマンド
agent-autotune hook <event>    # Claude Code Hooks専用、stdin JSON
```

- `init`は**冪等**：何度実行してもHooksや環境設定が重複しない。設定のバックアップを先に作る。
- `uninstall`はAutoTuneが追加したHookエントリだけを識別して削除し、他人が追加した設定を残す。既存設定が変わっていた場合は上書きせず差分を確認する。
- `disable`時、Hookは空出力・exit 0、OTLP受信は停止または記録破棄。Claude Codeを妨げない。
- `status`では過度に断定せず「観測できたコスト・トークン」「失敗の推移」「根拠の有効性」を示す。

### `status`表示例（架空）

```text
Agent AutoTune v0.1  [enabled]
Claude Code: detected
OTLP logs: connected    OTLP metrics: connected
Observed tools (7d): 184 | Classified failures: 6
Active hints: 1 | Stale: 0 | Disabled: 0

[verified] project-a/package.json
  Missing: npm test
  Observed success: npm run test:unit
  Last validation: package hash matched
Effect: insufficient_data (no comparable evidence yet)
```

## 10. 安全性とプライバシー

1. **Fail-open**: Hookで例外、SQLiteロック、daemon停止、OTLP不達が起きてもClaude Codeの処理を妨げない。
2. **入力は不信任**: Hook stdin、OTLP JSON、package.json、ファイルパスを全て検証し、外部入力をshellで実行しない。
3. **シェルコマンドは実行しない**: コマンドの分類にshellを使わない。文字列を厳格な文法で判定し、複合コマンドや未解釈の構文は対象外。
4. **権限を変更しない**: `allow`/`deny`/`updatedInput`は使わない。認証情報やAPIキー、環境変数の値を記録しない。
5. **最小収集**: OTel側の詳細ログフラグはオフ。Hooks側でも入力直後にallowlistフィールドへ正規化し、任意のstdout/stderrや全文コマンドを保存しない。
6. **Path safety**: `realpath`でプロジェクト/パッケージを検証。シンボリックリンクやパストラバーサルでルート外を参照しない。
7. **機密情報**: ヘッダートークンは0600、データディレクトリ0700。localhostのみリッスン。ユーザー権限で動く他プロセスからのアクセスを完全に防げるものではないと明記。
8. **設定変更の範囲**: `init/uninstall`はユーザーの承認後に実行。`CLAUDE.md`やリポジトリの共有設定は変更しない。
9. **不正なヒント対策**: 注入内容は固定テンプレート＋厳格に検証したscript名のみ。package.jsonのスクリプト本文や外部テキストをそのまま注入しない。
10. **ドライラン**: `init --dry-run`で変更対象を確認可能にする。MVPでは任意の自動適用を中断できる`disable`を必須にする。

## 11. パフォーマンス要件

- Hookプロセスの**p95追加待ち時間 100ms以下（ローカル環境の実測）**を目標。上限2秒で失敗時は空出力。
- 高頻度のPostToolUseの保存は軽量であること。重い分析はdaemon側で非同期実行する。
- SessionStartでのヒント作成とDB記録は、通常のローカル使用でp95 100ms以下を目標。
- 1イベントの受信サイズ上限256KiB（上限超過は拒否または安全に破棄）。フル内容は保存せず許可属性のみ取得。
- OTelの再送・重複受信が発生しても、集計が二重にならない。
- daemonが停止しても、再起動したら収集を再開する。観測不能な時間帯の数値は欠損として扱う。
- macOS上で追加のDocker/Grafana/外部DBは不要。

## 12. テスト計画

### Unit Tests

- `npm test`/`npm run test:unit`の厳格な解析。`npm test && rm ...`、`cd x && npm test`、クォート、変数展開などは対象外。
- `Missing script`の分類（エラーメッセージ変化、不一致、切断データを含む）。
- `package.json`の破損、複数script候補、workspace違い、scriptの削除/変更。
- Hook payloadの不足・未知フィールド・大きすぎる入力でもfail-open。
- OTel属性配列、resource attribute、`tool_use_id`相関、重複受信、後着OTel。
- ヒントのステートマシン、失効、重複注入防止、文字数制限。
- 機密値がDB/ログに保存されないこと。

### Integration Tests

1. 一時プロジェクトA：`npm test`失敗（scriptなし）→ `npm run test:unit`成功 → `verified`になる。
2. 新しい通常セッションの`SessionStart`でヒントが**1回だけ**返る。
3. `package.json`を変更するとヒントが`stale`となり、注入されない。
4. 複数候補の時は自動注入しない。
5. 異なるプロジェクトBへヒントが漏れない。
6. daemon停止、DBロック、入力JSON不正、OTLP停止でもClaude Codeをブロックしない。
7. `init`を2回実行しても設定重複なし。`uninstall`で元の設定を保持。
8. 実際のClaude Codeで、非ゼロ終了がどのHookに現れるかを**実機確認**する。未観測なら失敗認識ロジックを修正してからリリース。
9. 送信トークン・プロンプト・機密引数の漏出がないことをフィクスチャ検証。

### Acceptance Criteria (リリース判定)

- [ ] `init`後、`claude`を通常起動してデータが記録される。
- [ ] OTelの`claude_code.tool_result`イベントとHookイベントが`tool_use_id`でjoinできる。
- [ ] R001の一連の観測→検証→注入→失効が自動で動く。
- [ ] 別タスクを意図的に再実行する必要がない。
- [ ] 改善ヒントは根拠に反すると判断した瞬間に注入停止する。
- [ ] 収集障害がエージェントの作業を止めない。
- [ ] `status`、`rules`、`disable`、`uninstall`が機能する。
- [ ] デフォルト設定でプロンプト本文・コード・機密情報を保存しない。
- [ ] 他のClaude設定と競合した場合、黙って上書きしない。
- [ ] 上記の統合テストとリグレッションテストが通る。

## 13. 実装ステップ（この順番で開発）

### Phase 1 — 観測と取り込み

- CLI骨格 / `daemon` / `doctor`。
- OTLP/HTTP JSON Logs + Metrics Receiver、Hook stdin Receiver、最小SQLite schema。
- 既存Claude Code設定と共存する`init`。
- 実機でtool失敗・成功・OTelイベントを確認。**最初のGo/No-Go**：`tool_use_id`で相関可能か。

### Phase 2 — 最初の学習ループ

- R001の分類・候補生成・成功検証・状態遷移。
- `SessionStart`からの固定テンプレート注入。
- `status`、`rules`、手動無効化。

### Phase 3 — 継続評価と安全性

- package.jsonハッシュ確認と自動失効。
- 実行失敗の集計、観測不足の表示。
- `disable/enable/uninstall`、設定のリストアとプライバシーテスト。
- 体感オーバーヘッド測定、配布用README。

## 14. リポジトリ構成案

```text
agent-autotune/
├── spec.md
├── README.md
├── package.json
├── tsconfig.json
├── src/
│   ├── cli.ts
│   ├── commands/{init,doctor,status,rules,disable,enable,uninstall}.ts
│   ├── daemon/server.ts
│   ├── telemetry/{otlp-http,normalizer,correlation}.ts
│   ├── hooks/{handler,session-start,tool-result}.ts
│   ├── rules/{engine,r001-npm-script}.ts
│   ├── store/{sqlite,schema,migrations}.ts
│   ├── project/{detect,package-json}.ts
│   ├── security/{sanitize,path-guard,local-token}.ts
│   └── config/{claude-settings,launchd}.ts
├── tests/
│   ├── fixtures/{hooks,otlp,projects}/
│   ├── unit/
│   └── integration/
└── scripts/
```

## 15. MVP完成後に検証する仮説

1. 一般的な個人開発環境で、同一プロジェクトの失敗コマンドはセッションをまたいで再発するか。
2. Claude CodeのAuto-memoryや既存プロジェクト指示だけでは防げない失敗が残るか。
3. 1つの短いヒントで、関連する失敗が自然に減少する傾向は見えるか。
4. 自動注入によるトークン増・ノイズが利益を上回らないか。

**Go/No-Go判断**: 1〜2週間の通常利用で、R001対象の再発・改善機会がほとんど存在しない場合、対象範囲を安易に拡大せず、この製品仮説を再検討する。次の候補（環境セットアップの繰り返し、ユーザーの手戻り、コンテキスト浪費など）は、実測された課題があってから追加する。

## 16. 根拠資料（2026-11-12確認）

- [Claude Code — Monitoring](https://code.claude.com/docs/en/monitoring-usage): `CLAUDE_CODE_ENABLE_TELEMETRY`、OTLP設定、`claude_code.tool_result`、`tool_use_id`、`prompt.id`、Traces beta。
- [Claude Code — Hooks reference](https://code.claude.com/docs/en/hooks): `SessionStart`、`PostToolUse`、`PostToolUseFailure`、JSON入出力、`additionalContext`、失敗時挙動。
- [Claude Code — Settings files and precedence](https://code.claude.com/docs/en/settings): `~/.claude/settings.json`とプロジェクトスコープ設定の差異。
- [OpenTelemetry — JavaScript](https://opentelemetry.io/docs/languages/js/): SDKとLogs/Metrics/Tracesの状態。
- [OpenTelemetry — Exporters](https://opentelemetry.io/docs/languages/js/exporters/): OTLP/HTTPの取り扱い。

**実装時再検証が必要な点**: `PostToolUse`と`PostToolUseFailure`への非ゼロ終了の振り分け、OTLP/HTTP JSONの具体的なリクエスト/レスポンス形式、環境変数の既存設定との優先順位、OS起動時のlaunchdの振る舞い。仕様変更に強いアダプターとして実装する。
