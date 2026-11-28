<div align="center">

# <img src="./images/VRCX.png" width="64" height="64" alt="VRCX-Worker Logo" /> VRCX-Worker

**Cloudflare Workers（無料プラン）で動作する完全ステートレス・クラウドホスト版 VRCX**

*オリジナル [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)（MIT ライセンス）からの派生プロジェクト*

[English](./README.md) | [简体中文](./README.zh-CN.md) | **日本語**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker)
[![GitHub Release (VRCX.Agent)](https://img.shields.io/github/v/release/nuomew/VRCX-Worker?label=VRCX.Agent)](https://github.com/nuomew/VRCX-Worker/releases/latest)
[![GitHub Repository](https://img.shields.io/badge/GitHub-nuomew%2FVRCX--Worker-181717?logo=github)](https://github.com/nuomew/VRCX-Worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

## プロジェクト概要

**VRCX-Worker** は [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)（ベースライン `2026.11.14`）をベースに、**Cloudflare Workers の無料プラン（Free Tier）** で個人向けに 24 時間運用できるよう再設計したクラウド版 VRCX です。オリジナルの Vue 3 UI を完全ステートレスな Web アプリとして提供し、**Cloudflare Workers + 6 シャード D1 + SQLite Durable Object（WebSocket Hibernation）+ Workers AI + 任意の外部 MySQL 5.7+ / MariaDB + 任意の R2 / Backblaze B2 ストレージ**、および任意の軽量 Windows 常駐コンパニオン（[`VRCX-Agent/`](./VRCX-Agent/)）と連携します。

- **100% ステートレスなブラウザ設計（ローカル保存不要）**：ブラウザの OPFS や IndexedDB をプライマリ DB として使用しません。キャッシュ削除・シークレットウィンドウ・PC／スマートフォン間の切り替えを行っても、設定・メモ・お気に入り・フレンド履歴・ゲームログ・通知・暗号化保存された VRChat セッションをすべてクラウドから復元できます。
- **24 時間クラウド RSS 定期集約・6 シャード圧縮 D1 & 任意の外付け MySQL 5.7+**：
  - 毎分起動する Cloudflare Cron（`* * * * *`）が Web 側で設定した同期インターバル（既定 `300秒` / 5 分）に従い、ブラウザを閉じていてもフレンドのオンライン／オフライン／GPS（デュアル環境フラップ抑制付き）／ステータス／プロフィール変更・Friend Log・v1/v2 通知を自動記録し、`DB_CACHE`（`vrcx-cache`）を予熱します。
  - 全 6 D1 シャードの大容量テーブルは **透過 gzip 圧縮 ≤1,000 行コンパクトチャンク** として保存され、無料枠の容量と日次書き込み制限を保護します。
  - 任意の **外部 MySQL 5.7+ / MariaDB**（ゼロ依存クライアントまたは Hyperdrive）による新規書き込みオフロード／全量移行に対応し、容量上限到達や外部 DB 障害時は **自動的に読み取り専用ベーシックモードへ縮退** します。
- **アニメ公式サイト風デュアル独立テーマ & Web UI 強化**：
  - 既存の 4 テーマ（System / Light / Dark / Midnight）に一切影響を与えない独立レイアウトシェルとして、**ルックブック（Lookbook）** と **アズールアーカイブ（Azure Archive）** の 2 テーマを搭載。
  - **8 色の全画面背景色切替**（Web ビルド時のコンテンツハッシュ付与によるキャッシュ無効化）、全ドロップダウン／モーダル／Toast より上位で均一に効く **50%〜100% グローバル明るさ調整（リロード時初回描画前ゼロフラッシュ復元付き）**、均等配置・文字切れゼロのトップナビ、およびルックブック左パネルでのネイティブ分類 `FriendsSidebar` 再利用＋仮想スクロールを備えます。
  - ワールド背景付き **4 列フレンド位置カード**、4 大履歴テーブルの **記録日別／月別ナビゲーター**、**公開アバター検索**（`#/tools/avatar-search`）、**ブラックリスト専用ビュー**、Cloudflare Workers AI 駆動の **VRChat OSC リアルタイムチャット翻訳**（無料 Neurons 消費可視化）、および相互排他の **静的パスフレーズ / RFC-6238 TOTP 2FA**（30 日信頼 Cookie）に対応。
- **デスクトップ履歴移行・SQLite 出力 & 軽量 Windows コンパニオン（[`VRCX-Agent/`](./VRCX-Agent/)、CEF / Electron 不使用）**：
  - Windows タスクトレイに常駐する軽量 .NET 10 アプリ（標準インストーラー版・スタンドアロン ZIP 版・約 1.5 MB ポータブル版）。**GitHub Releases からの 10 分間隔 ETag 確認＋SHA-256 検証付き自動アップデート** を内蔵。
  - クラウド制御の **マルチスレッド過去データ移行**（テーブル単位カーソル再開、リトライ重複排除、カテゴリ照合・修復）および標準 **`VRCX.sqlite3` 直接エクスポート** に対応。
  - Web 側で指定した間隔（既定 `60秒`、`30〜3600秒`）での HTTPS `POST /api/agent/sync`、オフライン JSONL キュー、差分 `output_log_*.txt` バックフィル、および独立した `/ws/chat-agent` OSC リアルタイム翻訳チャネルを備えます。
  - **ダイレクト接続 / プロキシ経由** のワンクリック切替（システムプロキシ、HTTP/HTTPS/SOCKS4/SOCKS5、ネイティブ **VMess AEAD `vmess://`**）、在室プレイヤー一覧、VRChat / SteamVR 起動時刻、ローカル PNG メタデータ書き込み、任意の **R2 / Backblaze B2** クラウドギャラリー送信、Discord RPC、AutoAppLaunch、XSOverlay / OVRToolkit 通知、6 種の許可リスト制リモートコマンドに対応。
- **リポジトリの明確な分離とデスクトップ版ゼロリグレッション**：オリジナルのデスクトップ版専用コードはすべて [`desktop/`](./desktop/) 配下へ分離し、二次開発の本体（`wrangler.jsonc`、`cloud/`、`VRCX-Agent/`、`src/` Web アダプタ、`docs/`）をリポジトリルートに配置しています。

---

## システムアーキテクチャ

```mermaid
flowchart LR
    Browser["ブラウザ（PC / モバイル）<br/>VRCX Vue 3 SPA (--mode web)"] -->|HTTPS + 暗号化 Cookie| Worker["Cloudflare Worker<br/>cloud/src/index.ts"]
    Agent["Windows コンパニオン<br/>VRCX.Agent（トレイ常駐）"] -->|HTTPS 同期 / 移行 / OSC WS| Worker
    Cron["Cloudflare Cron<br/>(* * * * *)"] -->|オフライン RSS フィード・通知集約| Worker

    Worker --> DBCore[("D1: DB_CORE<br/>vrcx-core")]
    Worker --> DBGame[("D1: DB_GAMELOG<br/>vrcx-gamelog")]
    Worker --> DBFeed[("D1: DB_FEED<br/>vrcx-feed")]
    Worker --> DBCache[("D1: DB_CACHE<br/>vrcx-cache")]
    Worker --> DBLegacy[("D1: DB_LEGACY<br/>vrcx-legacy")]
    Worker --> DBChat[("D1: DB_CHAT<br/>vrcx-chat")]
    Worker --> DO["Durable Object (SQLite)<br/>AgentHubDO (WS Hibernation)"]
    Worker --> AI["Workers AI<br/>OSC チャット翻訳"]
    Worker -. 任意 .-> MySQL[("外部 MySQL 5.7+<br/>直結 / Hyperdrive")]
    Worker -. 任意 .-> R2[("R2 / Backblaze B2<br/>メディア & バックアップ")]
    Worker --> VRC["VRChat 公式 API<br/>api.vrchat.cloud"]
```

### Cloudflare 無料プラン向け設計ポイント

| コンポーネント | バインディング / リソース | 役割と無料枠保護の仕組み |
|---|---|---|
| **静的アセット** | `./build/web` | ビルド済み Vue SPA を Cloudflare エッジから直接配信し Worker 実行回数を節約（CSS・i18n JSON はハッシュ付き出力で古いキャッシュを防止） |
| **コア DB シャード** | `DB_CORE`（`vrcx-core`） | 設定バンドル、統計カウンター、`entity_users`/`entity_worlds` FTS5 辞書、メモ、お気に入り、アバタータグ、圧縮 Friend Log・通知、デバイス・コマンド管理、AES-256-GCM Cookie ボールト |
| **ゲームログシャード** | `DB_GAMELOG`（`vrcx-gamelog`） | 透過 gzip 圧縮チャンク（`gamelog_archive_chunks`）およびユーザー／ワールド集計ロールアップ |
| **フィードシャード** | `DB_FEED`（`vrcx-feed`） | 透過 gzip 圧縮チャンク（`feed_archive_chunks`：GPS、オンライン／オフライン、ステータス、プロフィール）と `activity_sessions_v2` |
| **キャッシュシャード** | `DB_CACHE`（`vrcx-cache`） | サーバー側階層キャッシュ（`vrc_api_cache`）と RSS スナップショットを保持し、`api.vrchat.cloud` への重複アクセスを削減 |
| **過去データ移行シャード** | `DB_LEGACY`（`vrcx-legacy`） | デスクトップ版 VRCX からインポートした履歴チャンク・ロールアップ・設定・移行進捗カーソル専用シャード |
| **チャット翻訳シャード** | `DB_CHAT`（`vrcx-chat`） | OSC リアルタイムチャット翻訳ログ、プリセット、Workers AI Neurons 消費計測を分離管理 |
| **Workers AI** | `AI` | Cloudflare Workers AI バインディング（無料枠 1 日 `10,000` Neurons）でリアルタイムチャット翻訳を実行 |
| **Durable Object** | `AGENT_HUB`（`AgentHubDO`） | SQLite WebSocket Hibernation（`ctx.acceptWebSocket` + 自動 `ping`/`pong`）によるライブ中継、コマンド配信、および `/ws/chat-agent` |
| **外部 DB & オブジェクトストレージ** | `外部 MySQL 5.7+`、`R2_MEDIA` / `Backblaze B2` *(任意)* | 大容量テーブルの外部 MySQL オフロード、およびクラウドギャラリー写真・DB クリーンアップバックアップの保存 |

---

## クイックスタート：Cloudflare Workers ワンクリックデプロイ

> 詳しいデプロイ手順、セキュリティシークレット、R2 ギャラリー設定、Windows コンパニオン連携手順は以下のガイドをご参照ください：
> - **日本語**：[`docs/cloud-architecture/DEPLOY.ja.md`](./docs/cloud-architecture/DEPLOY.ja.md)
> - **English**：[`docs/cloud-architecture/DEPLOY.md`](./docs/cloud-architecture/DEPLOY.md)
> - **简体中文**：[`docs/cloud-architecture/DEPLOY.zh-CN.md`](./docs/cloud-architecture/DEPLOY.zh-CN.md)

1. 上部の **Deploy to Cloudflare** ボタンをクリックするか、**Cloudflare ダッシュボード → Workers & Pages → 作成 → リポジトリをインポート** から **`nuomew/VRCX-Worker`** を選択します。
2. ルートディレクトリ（`.`）および既定のデプロイコマンド `npx wrangler deploy` をそのまま維持します：
   - ルートの [`wrangler.jsonc`](./wrangler.jsonc) に `"build": { "command": "npm run build:web" }` が定義されているため、ダッシュボードの **ビルドコマンド** を空欄のままにしても `./build/web` へ自動ビルドされます。
   - Cloudflare Automatic Resource Provisioning により **6 つの D1 シャード**（`vrcx-core`、`vrcx-gamelog`、`vrcx-feed`、`vrcx-cache`、`vrcx-legacy`、`vrcx-chat`）、`AgentHubDO`、`AI` バインディングが自動作成されます（`R2_MEDIA` は R2 未契約環境でも通るよう既定オフであり、`keep_vars` と `unsafe.metadata.keep_bindings` により手動バインド済み R2 やシークレットは Git 自動デプロイ後も保持されます）。
   - 初回 HTTP リクエスト時に [`cloud/src/db/schemaBootstrap.ts`](./cloud/src/db/schemaBootstrap.ts) が全テーブル・インデックス・FTS5 辞書を冪等に自動初期化します。
3. **推奨セキュリティ設定**：通常利用を開始する前に、**Worker → 設定 → 変数とシークレット（Variables and Secrets）** にて `ADMIN_PASSCODE`、`ADMIN_TOTP_SECRET`、`COOKIE_MASTER_KEY`、または Cloudflare Access（`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`）を設定するか、Web UI の **設定 → セキュリティ** から静的パスフレーズまたは TOTP 2FA を有効化してください。
4. *(任意)* [GitHub Releases](https://github.com/nuomew/VRCX-Worker/releases/latest) から **`VRCX.Agent-v*-Setup-win-x64.exe`** をダウンロードしてインストールし、Web UI 下部ステータスバーの **Cloud → Win Agent (HTTP Sync)** で同期シークレットを作成して `VRCX.Agent` に入力し、**Test & Save** をクリックします。

---

## 機能一覧

| 機能カテゴリ | クラウド Web UI（`--mode web`） | Windows コンパニオン（`VRCX.Agent`） |
|---|---|---|
| フレンド・ワールド・アバター・グループ・ブラックリスト・お気に入り・メモ・統計 | 標準対応（D1 / 外部 MySQL ステートレス保存） | — |
| 公式アニメ風デュアルテーマ（ルックブック / アズールアーカイブ）+ 背景色 & 明るさ | 8 色全画面背景切替、最上位グローバル明るさ調整 & ゼロフラッシュ復元 | — |
| 記録日別履歴ナビゲーター & 公開アバター検索 | 4 大履歴テーブルの日付／月ジャンプ、公開アバター検索ツール | — |
| 24 時間オフライン Feed・Friend Log・通知記録 | 標準対応（Cloudflare Cron RSS + デュアル GPS 抑制） | — |
| デスクトップ版 VRCX 履歴移行 & 標準 `VRCX.sqlite3` エクスポート | クラウドジョブ管理・カテゴリ照合・ワンクリック修復 | マルチスレッド再開対応アップロード & `.sqlite3` 直接出力 |
| VRChat OSC リアルタイムチャット翻訳 | Workers AI 翻訳、無料 Neurons 配額リング & 履歴表示 | 独立 `/ws/chat-agent` でローカル VRChat OSC と双方向連携 |
| 外部 MySQL 5.7+ & R2 / Backblaze B2 クラウドストレージ | ハイブリッド／全量 MySQL オフロード、B2/R2 ギャラリー、自動読み取り専用縮退 | VRCX PNG メタデータ書き込み & R2 / B2 アップロード |
| VRChat ローカル `output_log_*.txt` 差分収集 & 在室プレイヤー／稼働時間 | GameLog・在室プレイヤー・稼働時間のリアルタイム表示 | バイトオフセット管理、オフライン JSONL キュー & OS プロセス起動時刻 |
| Discord Rich Presence・AutoAppLaunch・XSOverlay / OVRToolkit | Web 画面からリモート指示 | Windows ローカルで安全実行（6 種類の許可リスト制） |
| ダイレクト接続 / プロキシ・ネイティブ `vmess://` 対応 | Cloudflare エッジ経由でアクセス | トレイ／設定からワンクリック切替（HTTP/SOCKS/VMess） |

---

## リポジトリ構成

```text
VRCX-Worker/
├── wrangler.jsonc              # ルート Cloudflare Workers 自動デプロイ設定（Worker + Assets + 6 D1 + DO + AI + Cron）
├── package.json                # ルート Vite/Vitest スクリプト（wrangler が npm run build:web を自動実行）
├── src/                        # 共有 Vue 3 フロントエンド + WEB アダプタ & デュアル公式アニメ風テーマ：
│   ├── views/Layout/           #   MainLayout + LookbookLayout / ArchiveLayout + 優先ナビ & 明るさ制御
│   ├── styles/themes/          #   厳格スコープ分離された lookbook.css / archive.css（8 色全画面背景対応）
│   ├── ipc-web/                #   ブラウザ向けネイティブブリッジ代替（WebApi、AppApi、起動キャッシュ、RSS 同期）
│   ├── services/database/cloud/#   Worker API 経由の構造化クラウドリポジトリ（生 SQL 非公開）
│   └── components/cloud/       #   ロック画面、Cloud Hub、外部 MySQL / B2 ストレージ、デスクトップ移行 & 2FA UI
├── cloud/                      # Cloudflare Worker TypeScript バックエンド
│   ├── src/                    #   auth/、cache/、crypto/、db/（compactArchive、externalMysql*）、hub/、routes/、search/、storage/、sync/
│   ├── migrations/             #   core・gamelog・feed・cache・legacy・chat 各 D1 シャード用 SQL DDL
│   └── test/                   #   Miniflare / workerd 自動 Vitest テストスイート
├── VRCX-Agent/                 # 軽量 .NET 10 Windows トレイコンパニオン（Core/、Platform/、Installer/）
├── VRCX-Agent.Tests/           # クロスプラットフォーム xUnit テストスイート
├── docs/cloud-architecture/    # 多言語デプロイガイド（DEPLOY*.md）および技術仕様書（Tech-Spec.md）
├── desktop/                    # 分離されたオリジナル デスクトップ版 VRCX（ゼロリグレッション維持）：
│   ├── Dotnet/                 #   Windows CEF、Linux/macOS Electron .NET バックエンド、DBMerger、共有 Discord/PNG モジュール
│   ├── src-electron/           #   Electron メインプロセス、preload、Linux OpenVR ライブラリ
│   ├── Installer/              #   Windows NSIS デスクトップインストーラー一式
│   ├── build-scripts/          #   デスクトップ用ビルド・ライセンス生成・パッケージスクリプト
│   ├── VRCX.slnx               #   デスクトップ版 .NET ソリューション
│   ├── electron-builder.config.js
│   └── README/                 #   オリジナル デスクトップ版の多言語 README 群
├── images/                     # Web・Agent・デスクトップ共通アイコン
├── README.md                   # 英語ドキュメント
├── README.zh-CN.md             # 簡体字中国語ドキュメント
├── README.ja.md                # 日本語ドキュメント（本ファイル）
└── MEMORY.md                   # 設計判断・監査修正履歴・運用メモ
```

---

## ローカル開発と検証

### 必要環境
- **Node.js** `>= 24.15.0`（ローカルが Node 22 の場合は `--engine-strict=false` を付与）および **npm**
- **.NET 10 SDK**（`VRCX-Agent` および `desktop/Dotnet/` のビルド・テスト用）
- **Wrangler CLI**（`cloud/node_modules/.bin/wrangler` に同梱）

### ビルド・テストコマンド

```bash
# 1. フロントエンド Web SPA ビルド（./build/web 出力）とユニットテスト
npm ci
npm run build:web
npm run test

# 2. Cloudflare Worker 型チェック・workerd テスト・デプロイドライラン
npm --prefix cloud ci
npm --prefix cloud run typecheck
npm --prefix cloud test
./cloud/node_modules/.bin/wrangler deploy --dry-run

# 3. Windows コンパニオン VRCX.Agent のビルドと xUnit テスト（.NET 10 SDK）
dotnet build VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64
dotnet test VRCX-Agent.Tests/VRCX-Agent.Tests.csproj -c Release

# 4. オリジナル デスクトップ版の回帰確認（desktop/ 配下）
npm run prod
dotnet build desktop/Dotnet/VRCX-Electron.csproj -c Release -p:Platform=x64 -r linux-x64
```

### ローカル開発サーバーの起動

```bash
# ターミナル 1：ローカル Cloudflare Worker バックエンドを起動（http://127.0.0.1:8787）
npm --prefix cloud run dev

# ターミナル 2：Vite Web 開発サーバーを起動（http://127.0.0.1:9000、/api・/ws・/health を自動プロキシ）
npm run dev:web
```

---

## ドキュメント一覧

| ドキュメント | English | 简体中文 | 日本語 |
|---|---|---|---|
| **プロジェクト概要** | [`README.md`](./README.md) | [`README.zh-CN.md`](./README.zh-CN.md) | [`README.ja.md`](./README.ja.md) |
| **デプロイ & Windows 伴侶ガイド** | [`DEPLOY.md`](./docs/cloud-architecture/DEPLOY.md) | [`DEPLOY.zh-CN.md`](./docs/cloud-architecture/DEPLOY.zh-CN.md) | [`DEPLOY.ja.md`](./docs/cloud-architecture/DEPLOY.ja.md) |
| **アーキテクチャ技術仕様書** | [`Tech-Spec.md`](./docs/cloud-architecture/Tech-Spec.md) | — | — |
| **オリジナル デスクトップ版 README** | [`desktop/README/`](./desktop/README/) | [`desktop/README/README.zh_CN.md`](./desktop/README/README.zh_CN.md) | [`desktop/README/README.jp.md`](./desktop/README/README.jp.md) |

---

## クレジットおよび VRChat 利用規約（TOS）について

- **オリジナルプロジェクト**：本プロジェクトは **[vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)**（`© 2019–2026 pypy, Natsumi, Map1en & VRCX Contributors`）をベースに [MIT ライセンス](./LICENSE) の下で提供されています。
- **VRChat TOS**：オリジナル VRCX と同様、VRCX-Worker は VRChat 公式 API とローカルログファイルのみを参照する外部補助ツールであり、VRChat ゲームクライアントを一切改変しません。
- VRCX-Worker は VRChat Inc. の公式製品ではなく、同社の見解や承認を反映するものではありません。VRChat および関連商標は VRChat Inc. に帰属します。
