# VRCX-Worker デプロイ & Windows コンパニオン導入ガイド

[English](./DEPLOY.md) | [简体中文](./DEPLOY.zh-CN.md) | **日本語**

[← README に戻る](../../README.ja.md) · [技術仕様書 (EN)](./Tech-Spec.md)

> オリジナル [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)（MIT ライセンス）からの派生プロジェクト。リポジトリ：[https://github.com/nuomew/VRCX-Worker](https://github.com/nuomew/VRCX-Worker)。

---

## 目次
1. [デプロイ方法（Cloudflare Workers 無料プラン）](#1-デプロイ方法cloudflare-workers-無料プラン)
2. [セキュリティ・アクセス保護・暗号化シークレット設定](#2-セキュリティアクセス保護暗号化シークレット設定)
3. [クラウド写真ギャラリー設定（任意の Cloudflare R2）](#3-クラウド写真ギャラリー設定任意の-cloudflare-r2)
4. [2 種類の同期間隔と 24 時間オフライン Cron RSS](#4-2-種類の同期間隔と-24-時間オフライン-cron-rss)
5. [Windows トレイコンパニオン（`VRCX.Agent`）導入手順](#5-windows-トレイコンパニオンvrcxagent導入手順)
6. [ソースからの `VRCX.Agent` / オリジナルデスクトップ版ビルド](#6-ソースからの-vrcxagent--オリジナルデスクトップ版ビルド)
7. [トラブルシューティング & FAQ](#7-トラブルシューティング--faq)

---

## 1. デプロイ方法（Cloudflare Workers 無料プラン）

VRCX-Worker は **単一の Cloudflare Worker** として動作し、ビルド済み Vue 3 Web SPA（`./build/web`）とクラウド API / Cron / WebSocket バックエンド（`cloud/src/index.ts`）の両方を配信します。データ層は **自動プロビジョニングされる 4 つの D1 シャード**（`DB_CORE`、`DB_GAMELOG`、`DB_FEED`、`DB_CACHE`）、SQLite WebSocket Hibernation 対応 Durable Object（`AgentHubDO`）、および任意のプライベート R2 バケット（`R2_MEDIA`）で構成されます。

### 方法 A：ワンクリック / Cloudflare ダッシュボード Git 自動デプロイ（推奨）

1. [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker) をクリックするか、**Cloudflare ダッシュボード → Workers & Pages → 作成 → リポジトリをインポート** から **`nuomew/VRCX-Worker`**（またはご自身のフォーク）を選択します。
2. 既定のビルド・デプロイ設定をそのまま維持します：
   - **ルートディレクトリ**：`.`（リポジトリルート）
   - **ビルドコマンド**：*空欄のままで問題ありません* — ルートの [`wrangler.jsonc`](../../wrangler.jsonc) に `"build": { "command": "npm run build:web" }` が定義されているため、デプロイ時にフロントエンドが自動ビルドされます。
   - **デプロイコマンド**：`npx wrangler deploy`
3. デプロイを実行します。初回デプロイ時は以下が自動で完了します：
   - Cloudflare Automatic Resource Provisioning により 4 つの D1 データベース（`vrcx-core`、`vrcx-gamelog`、`vrcx-feed`、`vrcx-cache`）、`AgentHubDO`、`R2_MEDIA` が自動作成されます。
   - 初回 HTTP アクセス時に [`cloud/src/db/schemaBootstrap.ts`](../../cloud/src/db/schemaBootstrap.ts) が全テーブル・インデックス・FTS5 `trigram` 検索辞書を冪等に初期化します（手動 SQL マイグレーション不要）。
   - 以降 `master` ブランチへプッシュするだけでフロントエンドと Worker が自動再デプロイされます。

### 方法 B：ローカル Wrangler CLI でのデプロイ

> Wrangler コマンドは `cloud/` 内ではなく、必ず**リポジトリルート**（ルート `wrangler.jsonc` を参照）から実行してください。

```bash
# ルートおよび cloud 依存関係のインストール
npm ci
npm --prefix cloud ci

# 任意：ビルドとバインディングのドライラン確認
./cloud/node_modules/.bin/wrangler deploy --dry-run

# Cloudflare へデプロイ
./cloud/node_modules/.bin/wrangler deploy
```

---

## 2. セキュリティ・アクセス保護・暗号化シークレット設定

初回デプロイ直後は動作確認しやすいよう `open_setup` モードで起動します。**普段使いを始める前に、必ず Cloudflare ダッシュボード → Workers & Pages → 対象 Worker → 設定 → 変数とシークレット（Variables and Secrets）にて認証と暗号化キーを設定してください**：

| シークレット / 変数名 | 役割 | 推奨度 |
|---|---|---|
| `ADMIN_PASSCODE` | Cloud Gate ロック画面と HMAC 署名付き `HttpOnly; Secure; SameSite=Strict` セッション Cookie を有効化（D1 レート制限付き） | **推奨**（または Cloudflare Access を利用） |
| `ADMIN_TOTP_SECRET` | ロック解除時の二要素認証（2FA）用 Base32 RFC-6238 TOTP シークレット（ワンタイムリプレイ防止付き） | 任意（`ADMIN_PASSCODE` との併用推奨） |
| `COOKIE_MASTER_KEY` | `cloud_cookie_vault` 内の VRChat Cookie や Agent 秘密鍵を AES-256-GCM 暗号化する 32 文字以上のマスターキー | **強く推奨**（`ADMIN_PASSCODE` 未設定の Cloudflare Access 環境では必須） |
| `CF_ACCESS_TEAM_DOMAIN` & `CF_ACCESS_AUD` | Cloudflare Zero Trust Access による JWT 検証を有効化（チームドメインと Application AUD タグ） | 任意（`ADMIN_PASSCODE` の代替） |
| `AGENT_SYNC_KEY` | `VRCX.Agent` 定期 HTTP 同期用の静的 Bearer キー（Web の Cloud Hub で端末別キーを発行する場合は不要） | 任意 |
| `VRC_ALLOW_CLOUD_FALLBACK` | 既定値 `"true"` のまま運用してください。現行の HTTP 同期版 `VRCX.Agent` は WebSocket 経由の VRChat API リレーを持たないため、`"false"` にすると Worker 直接通信が無効化されます（カスタム WS RPC Agent 専用） | 既定 `"true"` |
| `POC_ADMIN_TOKEN` | ローカル開発・診断用の高権限静的 Bearer トークン（Web / Agent API の両方で有効。本番運用では通常未設定を推奨） | 開発・診断用 |

### 強力なランダムシークレットの生成例

```bash
# 48 文字相当のランダム COOKIE_MASTER_KEY を生成
openssl rand -base64 36

# Google Authenticator / 1Password 等に登録可能な Base32 形式 ADMIN_TOTP_SECRET を生成
python3 -c 'import base64, os; print(base64.b32encode(os.urandom(20)).decode().rstrip("="))'
```

> **Cloudflare Access 利用時の注意**：`ADMIN_PASSCODE` を設定せず `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` のみを使用する場合は、VRChat セッション暗号化のために `COOKIE_MASTER_KEY` も必ず設定してください。

---

## 3. クラウド写真ギャラリー設定（任意の Cloudflare R2）

Cloudflare R2 をバインドすると、どのデバイスのブラウザからでも **Tools → Gallery（クラウドギャラリー）** で日付別に VRChat スクリーンショットを閲覧・ダウンロードできます（Cloudflare R2 無料枠：**月 10 GB 保存・データ転送量無料**）。

| 項目 | 設定値 | 備考 |
|---|---|---|
| バインディング種別 | `R2 bucket` | ルートの [`wrangler.jsonc`](../../wrangler.jsonc) に定義済み |
| 変数名（`binding`） | `R2_MEDIA` | `cloud/src/env.ts` が参照する正確な名称 |

### 設定方法
1. **自動プロビジョニング（既定）**：ルートの `wrangler.jsonc` には既に `"r2_buckets": [{ "binding": "R2_MEDIA" }]` が含まれています。Cloudflare アカウントで R2 を有効にしておけば、Git 自動デプロイ時にもバインディングが維持されます。
2. **既存のカスタムバケットを指定する場合**：独自のプライベートバケット（例：`vrcx-media`）を使う場合は、ルート `wrangler.jsonc` の `R2_MEDIA` に `"bucket_name": "vrcx-media"` を追記してプッシュしてください。
3. `R2_MEDIA` 未設定でも、スクリーンショットのメタデータやゲームログはエラーなく D1 に保存されます。

---

## 4. 2 種類の同期間隔と 24 時間オフライン Cron RSS

VRCX-Worker では、**クラウド側のポーリング間隔**と **Windows コンパニオンのアップロード間隔**を独立して管理します：

1. **Web / クラウド同期間隔（`cloud:webSyncIntervalSeconds`）**
   - **設定場所**：Web UI → **Settings → System → Cloud Sync Interval**
   - **既定値**：`300 秒`（5 分）、設定範囲 `60〜3600 秒`。
   - **動作内容**：
     - 毎分起動する Cloudflare Cron（`* * * * *`）がこの間隔に従って、ブラウザが閉じている間もフレンドのオンライン／オフライン／GPS／ステータス／Bio 更新、Friend Log（表示名変更・TrustRank 変動・フレンド追加／解除）、v1/v2 通知を D1 と `DB_CACHE` に集約します。
     - ブラウザ表示中は `/api/rss/feed` から集約済みスナップショットを取得するため、`api.vrchat.cloud` への過剰な個別リクエストが発生しません。
2. **Windows コンパニオン同期間隔（`cloud:syncIntervalSeconds`）**
   - **設定場所**：Web UI 下部ステータスバー **Cloud → Cloud Hub → Win Agent (HTTP Sync)**
   - **既定値**：`60 秒`（1 分）、設定範囲 `30〜3600 秒`。
   - **動作内容**：接続済み `VRCX.Agent` による定期 HTTPS 送信（`POST /api/agent/sync`）の周期とオンライン判定ウィンドウを制御します。

---

## 5. Windows トレイコンパニオン（`VRCX.Agent`）導入手順

`VRCX.Agent` は CEF や Electron を一切使わない超軽量な .NET 10 Windows タスクトレイ常駐アプリです。

### 配布パッケージ（[GitHub Releases](https://github.com/nuomew/VRCX-Worker/releases/latest)）
- **`VRCX.Agent-v*-Setup-win-x64.exe`（推奨インストーラー版）**：.NET 10 ランタイム同梱。管理者権限不要で `%LocalAppData%\Programs\VRCX.Agent` にインストールされ、Windows 起動時のバックグラウンド自動起動・上書きアップグレード・標準アンインストールに対応します。
- **`VRCX.Agent-v*-win-x64-standalone.zip`（スタンドアロン ZIP 版）**：.NET 10 ランタイム同梱。展開して `VRCX.Agent.exe` を実行するだけで動作します。
- **`VRCX.Agent-v*-win-x64-portable.zip`（軽量 ZIP 版・約 1.5 MB）**：別途 [.NET 10 Windows Desktop Runtime (x64)](https://dotnet.microsoft.com/download/dotnet/10.0) のインストールが必要です。

### 初回セットアップ手順
1. デプロイ済み VRCX-Worker Web UI を開き、下部ステータスバーの **Cloud → Win Agent (HTTP Sync)** を開きます。
2. **Cloud URL** をコピーし、任意の **Device Name** を入力して **Create Sync Secret** を押し、`vrcx_sync_...` トークンを発行します（D1 には SHA-256 ハッシュのみ保存され、いつでも失効可能です）。
3. `VRCX.Agent` を起動すると初回設定ウィンドウが表示されます：
   - **Cloud URL** と **Sync Secret** を貼り付けます。
   - **ネットワークモード**を選択します：
     - **Overseas (Direct)**：プロキシを使用せず直接 Worker に接続します（日本・海外の通常回線はこちらを推奨）。
     - **Mainland China (Proxy)**：プロキシ欄が空欄の場合は Windows システムプロキシを使用し、必要に応じて `http://127.0.0.1:7890`、`socks5://127.0.0.1:7891`、またはネイティブ **`vmess://...`** リンク（TCP / TCP+HTTP 偽装 / TLS / WS / WSS 対応）を指定できます。
   - 必要に応じて **Start with Windows**、**Sync VRChat Screenshots**（既定オフ）、**Compress Screenshots to WebP**（≤1600px・既定オフ）を設定します。
4. **Test & Save** をクリックするとタスクトレイに常駐します：
   - **トレイアイコンをシングルクリック**：設定ウィンドウを開く
   - **トレイアイコンをダブルクリック**：ブラウザで VRCX Cloud Web UI を開く
   - **右クリックメニュー**：即時同期、ダイレクト／プロキシ切替、スクリーンショット同期・圧縮切替、自動起動切替、アップデート確認、終了

### 主な機能
- **ログ差分収集 & 過去ログ補完**：全 `output_log_*.txt` の読み込みオフセットをファイル単位で永続化し、未読の過去ログを古い順にバックフィルします。オフライン時はローカル JSONL キューに一時保存し、復旧後に自動再送します。
- **在室プレイヤー & 正確な稼働時間**：OS の `Process.StartTime` と現在のインスタンス内プレイヤーを送信し、Web 側の再読み込みでも経過時間やプレイヤー一覧が失われません。
- **オンライン自動アップデート**：GitHub Releases を定期チェックし（レート制限時は `/releases/latest` リダイレクトへ自動フォールバック）、インストーラーの **SHA-256 ハッシュ検証** を通した場合のみ安全にサイレント更新を行います。
- **6 種類の許可リスト制リモートコマンド**：`launch_vrc`、`quit_vrc`、`clear_cache`、`send_vr_notify`、`discord_update`、`sync_now` のみ厳格なバリデーションの上で実行します。

---

## 6. ソースからの `VRCX.Agent` / オリジナルデスクトップ版ビルド

### `VRCX.Agent` のビルド（.NET 10 SDK が必要）

```powershell
# xUnit ユニットテストの実行
dotnet test VRCX-Agent.Tests/VRCX-Agent.Tests.csproj -c Release

# 軽量版のビルド（build/VRCX-Agent/publish-portable/VRCX.Agent.exe に出力）
dotnet publish VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained false -o build/VRCX-Agent/publish-portable

# 単一ファイル・自己完結版のビルド（build/VRCX-Agent/publish-selfcontained/VRCX.Agent.exe に出力）
dotnet publish VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o build/VRCX-Agent/publish-selfcontained
Copy-Item "images\VRCX.ico" "build\VRCX-Agent\publish-selfcontained\VRCX.ico" -Force
```

ローカルで Windows インストーラーをビルドするには Inno Setup 6 の `ISCC.exe /DSourceDir=..\..\build\VRCX-Agent\publish-selfcontained VRCX-Agent\Installer\VRCX-Agent.iss` で [`VRCX-Agent/Installer/VRCX-Agent.iss`](../../VRCX-Agent/Installer/VRCX-Agent.iss) をコンパイルしてください（または `v*` タグをプッシュすると [`.github/workflows/release-vrcx-agent.yml`](../../.github/workflows/release-vrcx-agent.yml) が自動で全 3 種類の配布物を公開します）。

### オリジナル デスクトップ版 VRCX のビルド（`desktop/` 配下）

```bash
# デスクトップ向け HTML とサードパーティライセンス生成（./build/html 出力）
npm run prod

# Linux / macOS Electron 用 .NET ライブラリのビルド
dotnet build desktop/Dotnet/VRCX-Electron.csproj -c Release -p:Platform=x64 -r linux-x64

# Windows CEF 版のビルド（Windows 環境のみ）
dotnet build desktop/Dotnet/VRCX-Cef.csproj -c Release -p:Platform=x64 -r win-x64 --self-contained
```

---

## 7. トラブルシューティング & FAQ

- **Q：デプロイ後にトップページを開くと `open_setup` と表示されます。**
  - シークレット未設定時の初期状態です。Cloudflare Worker の **Variables and Secrets** に `ADMIN_PASSCODE` と `COOKIE_MASTER_KEY` を設定して再読み込みしてください。
- **Q：4 つの D1 シャードやキャッシュ、R2 バインディングが正しく動いているか確認したい。**
  - Web UI 下部の **Cloud Hub** を開くか、Worker URL の `/health` にアクセスすると、`DB_CORE`・`DB_GAMELOG`・`DB_FEED`・`DB_CACHE`（`cacheDbDedicated: true`）・`R2_MEDIA` の状態を確認できます。
- **Q：`VRCX.Agent` からクラウドへの接続がタイムアウトします。**
  - プロキシが必要なネットワーク環境ではトレイメニューから **Proxy モード** に切り替え、システムプロキシ・HTTP/SOCKS5・`vmess://` のいずれかを設定して **Test & Save** で接続確認を行ってください。
- **Q：GameLog にはスクリーンショット記録があるのに、クラウドギャラリーに画像が表示されません。**
  - Cloudflare Worker のバインディングに `R2_MEDIA` が割り当てられていること、および `VRCX.Agent` 側で **Sync VRChat Screenshots**（既定オフ）を有効化していることをご確認ください。
