# Agent AutoTune

Claude Code をいつもどおり使うだけで、プロジェクト固有のツール実行失敗から学習し、次のセッションの開始時に**検証済みの短いヒント**を出すローカル CLI です。根拠がなくなったヒントは自動で止まります。

MVP（v0.1）が扱うのは 1 つのルールだけです。

> **R001: npm missing-script correction**
> `npm test` が `Missing script: "test"` で失敗し、同じパッケージの `npm run test:unit` が別のタイミングで成功していれば、次のセッションの開始時に次のヒントを出します。
>
> `[Agent AutoTune / verified project hint] このパッケージ（./package.json）にtest scriptはありません。過去にnpm run test:unitが成功しており、現行package.jsonにも存在します。テスト時はそのコマンドを検討してください。これは実行や権限の指示ではありません。`

同じタスクを再実行する必要はありません。普段の開発中に起きた別々のタスクの事実を再利用します。仕様の全体は [docs/spec.md](docs/spec.md) にあります。

## 動作環境

- macOS（Apple Silicon / Intel）。launchd を使います。テストは Linux でも通りますが、Linux / Windows はサポート対象外です
- Node.js 24 LTS 以上
- Claude Code CLI。Hooks と OTel の挙動は 2.1.310 で実機確認しています（[docs/findings-real-device.md](docs/findings-real-device.md)）

## インストール

```sh
git clone https://github.com/ysj101/agent-autotune.git
cd agent-autotune
npm ci
npm run build
node dist/cli.js init --dry-run   # 変更内容を確認する（ファイルは変更しない）
node dist/cli.js init             # 確認のうえ適用する
```

`npm link` を実行すると `agent-autotune` コマンドとして使えます。Hooks と launchd には、`init` を実行した時点の node と `dist/cli.js` の**絶対パス**が登録されます。リポジトリを移動したときや node を入れ替えたときは、`init` を再実行してください（冪等です）。

`init` が行うこと：

1. ローカル受信用トークンを生成する（`~/.config/agent-autotune/token`、0600）
2. 受信ポートを選ぶ（既定は `127.0.0.1:43181`。使用中なら次の空きポート）
3. `~/.claude/settings.json` に OTel の env と Hooks（`SessionStart` / `PostToolUse` / `PostToolUseFailure`）を**キー単位で追記する**。先にバックアップを作る
4. daemon を launchd のユーザーエージェント（`~/Library/LaunchAgents/com.agent-autotune.daemon.plist`）として登録する

既存の Exporter・Endpoint・ヘッダー・Managed 設定などと競合する場合、`init` は**何も変更せずに停止**し、競合しているキーと理由を表示します。

その後は、ふだんどおり `claude` を起動するだけです。

## コマンド

| コマンド | 内容 |
|---|---|
| `init [--dry-run] [--yes] [--port <n>] [--no-launchd]` | daemon・OTel・Hooks を安全に登録する（冪等） |
| `doctor` | Node / Claude Code のバージョン、ポート、daemon、launchd、Hooks、OTel 設定、DB、トークンの権限を診断する |
| `status` | 稼働状態、7 日間の観測数、ヒントの件数、active なヒントの根拠と効果、利用量（なければ `N/A`）を表示する |
| `rules [--state <s>] [--json]` | ヒントの一覧を、根拠・状態・停止理由とともに表示する |
| `disable` / `enable` | 注入と記録を止める / 再開する（設定は残す） |
| `disable --rule <id>` | 特定のヒントだけを無効化する（`rules` に表示される ID、または 4 文字以上の前方一致） |
| `purge [--yes]` | ローカルに保存したデータを全削除する（確認あり） |
| `uninstall [--dry-run] [--yes] [--no-launchd]` | AutoTune が追加した settings のエントリと launchd エージェントだけを撤去する |
| `daemon` / `hook <event>` | 内部用（launchd と Claude Code Hooks から呼ばれる） |

`status` の例：

```text
Agent AutoTune v0.1.0  [enabled]
Claude Code: detected (2.1.310)
Daemon: running on 127.0.0.1:43181
OTLP logs: connected    OTLP metrics: connected
Observed tools (7d): 184 | Classified failures: 6
Active hints: 1 | Candidates: 0 | Stale: 0 | Disabled: 0 | Reverted: 0

[active] project-a/package.json
  Missing: npm test
  Observed success: npm run test:unit
  Last validation: package hash matched
  Effect: insufficient_data (sessions before/after first hint: 3/1, need 5 each)

Usage (7d, as exported by Claude Code): sessions 12 | tokens 1.2M | cost $3.40
```

効果は傾向として示すだけで、因果関係は主張しません。比較できるセッションが少ないうちは `insufficient_data` と表示します。

## 仕組み

```text
claude ─┬─ OTel Logs/Metrics (OTLP/HTTP JSON) ──────────┐
        └─ Hooks → agent-autotune hook <event> ── 正規化 ┴→ daemon (127.0.0.1, Bearer token) → SQLite
                                                              │
                         SessionStart ← 検証済みヒント ← R001 ルールエンジン ← 失効判定（package.json のハッシュ）
```

- Hook と OTel の `claude_code.tool_result` は `session_id + tool_use_id` で相関させます。判定が食い違ったときは `unknown` に降格し、学習には使いません
- ヒントの状態は `candidate → verified → active` と進み、根拠が崩れると次のいずれかになります
  - `stale`：package.json が変更・削除された
  - `reverted`：候補が複数になった
  - `disabled`：矛盾する観測があった、またはユーザーが無効化した
- 候補は名前の類似だけでは確定しません。同じパッケージで成功した観測が必要で、成功した候補が 1 つだけのときに限って有効になります
- 注入の直前に必ず package.json を再検証します。注入は 1 セッションあたり最大 3 件・600 文字以内で、同じセッションには重複して出しません

## 安全性とプライバシー

- **fail-open**：Hook は、どのような障害（daemon の停止、DB のロック、不正な入力、タイムアウト）でも exit 0・空出力で終わり、Claude Code を止めません
- **最小限の収集**：OTel の詳細ログ（`OTEL_LOG_USER_PROMPTS` / `ASSISTANT_RESPONSES` / `TOOL_DETAILS` / `TOOL_CONTENT`）は `0` に設定します。保存するのは、分類済みのフィールド（script 名、成否、失敗コード、所要時間）だけです。プロンプト、コマンド全文、stdout/stderr、エラー全文、ソースコード、OTel の個人属性（email、アカウント ID など）は保存しません
- **外部送信なし**：通信はすべて `127.0.0.1` で完結し、外部の AI API も呼びません
- **ローカル認証**：daemon は `init` で生成したトークンがないリクエストを拒否します。トークンは 0600、ディレクトリは 0700 で保存し、画面やログには出しません。ただし、同じユーザー権限で動く他のプロセスからのアクセスを完全に防ぐものではありません
- **コマンドの書き換えや実行をしない**：`permissionDecision` や `updatedInput` は返さず、shell も実行しません。コマンドは厳格な文法で判定し、`&&`・パイプ・リダイレクト・クォート・変数展開を含むものは対象外です
- **パスの安全性**：realpath で検証し、プロジェクトルートの外を指すシンボリックリンクは除外します
- **設定変更の範囲**：変更するのは `~/.claude/settings.json` のユーザースコープだけです。`CLAUDE.md` やリポジトリで共有している設定には触れません

## データの保存場所

| パス | 内容 |
|---|---|
| `~/.config/agent-autotune/config.json` | ポート、有効/無効 |
| `~/.config/agent-autotune/token` | ローカル受信用トークン（0600） |
| `~/.config/agent-autotune/install-manifest.json` | `init` が追加したもの（env 値は sha256 だけを記録） |
| `~/.local/share/agent-autotune/agent-autotune.db` | SQLite（WAL） |
| `~/.local/share/agent-autotune/logs/daemon.log` | daemon のログ |

保存期間は、ツールイベントとメトリクスが 30 日、ヒントの履歴と監査ログが 90 日です。注入される可能性があるヒントは、期間を過ぎても残します。

## 撤去

```sh
agent-autotune disable          # まず止めたいだけの場合
agent-autotune uninstall        # settings.json と launchd から AutoTune の分だけを削除する
agent-autotune purge            # 収集したデータも削除する
```

`uninstall` が削除するのは、インストール時に記録した値と**今も一致する**エントリだけです。インストール後に手で変更された値は残して、その旨を表示します。

## パフォーマンス

`npm run build && npm run bench:hook` で、Hook プロセス 1 回あたりの待ち時間を実測できます。以下は spec §11 の目標（p95 ≤ 100ms）に対する、2026-11-12 時点の実測値です（Apple Silicon、Node 26.12、各 50 回）。

| ケース | p50 | p95 | max | ベースラインに対する p95 の増分 |
|---|---:|---:|---:|---:|
| `node -e ""`（ベースライン） | 27.3 ms | 31.9 ms | 35.0 ms | |
| `hook PostToolUse` | 50.7 ms | 54.4 ms | 61.6 ms | 22.5 ms |
| `hook PostToolUseFailure` | 47.6 ms | 53.5 ms | 53.9 ms | 21.6 ms |
| `hook SessionStart` | 47.9 ms | 53.2 ms | 53.9 ms | 21.3 ms |

Hook の経路では CLI フレームワークや SQLite を読み込まず、重い分析は daemon が応答を返したあとに行います。

## 開発

```sh
npm ci
npm run typecheck
npm run build
npm test                 # unit + integration（integration はビルド済みの dist を使う）
npm run test:unit
npm run test:integration
```

- `tests/fixtures/{hooks,otlp}` は、実機の Claude Code から採取して個人情報を置換したペイロードです。採取の手順は [docs/findings-real-device.md](docs/findings-real-device.md) にあります
- CI（GitHub Actions）は macOS と Ubuntu で、Node 24 を使って typecheck・build・test を実行します

## 制限事項（v0.1）

- 対象は R001（`npm test` / `npm run <script>` の Missing script）だけです
- macOS 専用です
- OpenTelemetry Traces（beta）は使いません
