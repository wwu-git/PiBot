# Pi Bot

**デスクトップのための、オープンソースでローカルファーストな AI エージェントチームです。** 名前を持つ AI Bot があなた自身のコンピューター上で作業します。1 体とチャットすることも、複数をグループチャットに入れることもでき、Bot は計画を立て、コマンドを実行し、ファイルを編集し、Web を閲覧し、コンピューターを操作します。リスクのある手順はすべてあなたの承認を待ちます。macOS、Windows、Linux で動作し、Android アプリもあります。[pi](https://github.com/earendil-works/pi) エージェントカーネル上に構築されています。

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue"></a>
  <a href="https://github.com/w01fb0ss/PiBot/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/w01fb0ss/PiBot?include_prereleases"></a>
  <img alt="Platforms" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android-lightgrey">
  <a href="https://pibot.space"><img alt="Website" src="https://img.shields.io/badge/website-pibot.space-8b5cf6"></a>
  <a href="https://pibot.space/en/guides/"><img alt="Docs" src="https://img.shields.io/badge/docs-pibot.space%2Fen%2Fguides-0ea5e9"></a>
</p>

<p align="center">
  <a href="docs/assets/pibot-intro-60s.mp4"><img src="docs/assets/pibot-intro-15s.gif" width="800" alt="15 秒でわかる Pi Bot (クリックすると音声付きの 60 秒の動画を再生します)"></a>
</p>

<p align="center">▶ <a href="docs/assets/pibot-intro-60s.mp4">60 秒の動画を見る</a> · <a href="https://pibot.space">ダウンロード</a> · <a href="docs/guide/README.md">ユーザーガイド</a> · <a href="https://pibot.space/en/guides/">オンラインドキュメント</a></p>

[English](README.md) · [中文](README.zh-CN.md) · [日本語](README.ja.md)

Pi Bot は、名前を持つ Bot のチームがあなた自身のコンピューター上で作業するデスクトップアプリです。Bot と直接チャットしたり、複数の Bot をグループチャットに入れたりして作業フォルダーを渡すと、Bot は計画を立て、コマンドを実行し、ファイルを編集し、互いに作業を引き継ぎます。リスクのある手順はすべてあなたの承認を待ちます。「頭脳」もあなたのマシン上で動作します。チャット、ファイル、メモリ、キーはローカルに保存され、あなたが送信したプロンプトを見るのは、あなたが選んだモデルプロバイダーだけです。

Web サイトとダウンロード: <https://pibot.space> · ユーザーガイド: [docs/guide](docs/guide/README.md) · オンラインドキュメント（英語）: <https://pibot.space/en/guides/>

## できること

- **Bot とロール。** 名前、ロール (開発者、リサーチャー、ライター、翻訳者など)、独自のモデル、スキル、権限、メモリを持つ Bot を作成できます。
- **ダイレクトチャットとグループチャット。** グループにはコーディネーターがいて、計画を立て、メンバーに手順を割り当て、結果を取りまとめます。計画は実行前にあなたが確認します。
- **作業フォルダーと変更。** Bot はあなたが選んだフォルダーの中で作業します。すべての変更が一覧表示されてレビューでき、macOS では自動チェックポイントから復元できます。
- **承認と権限。** すべてのツール呼び出しは 1 つのポリシーエンジンを通ります。コマンドはサンドボックス ([`@anthropic-ai/sandbox-runtime`](https://github.com/anthropics/sandbox-runtime)) で実行され、承認、コマンド、外部に送信されるものはすべて監査ログに記録されます。
- **ルーティンと ToDo。** スケジュール、フォルダー、接続をトリガーとするタスク。
- **接続。** アプリ、MCP サーバー、スキル、ナレッジベース。
- **モデル。** Ollama によるローカルモデル、OpenRouter、ご自身の API キー、対応しているサブスクリプションでのサインイン。
- **その他のデバイス (任意)。** Android アプリ、他のコンピューターやサーバー上のランナー、セルフホストできるリレー、ACP 経由でのエディターからの利用。

Pi Bot は macOS 13 Ventura 以降、Windows 10 / 11、64 ビット Linux で動作します。テレメトリはなく、Pi Bot 自身のサーバーがあなたのチャットやファイルを受け取ることはありません。選択したモデルプロバイダー以外に接続するのは、アップデートの確認、Bot が使用する Web サイトと検索、そしてあなたが有効にした機能 (スマートフォン、ランナー、接続) のみで、それぞれ事前に説明されます。すべての外部への接続については [docs/privacy](docs/privacy/en/outbound-connections.md) を参照してください。

## インストール

<https://pibot.space> からデスクトップアプリをダウンロードし、[はじめに](docs/guide/en/01-getting-started.md)に従ってください。

## ソースからビルド

必要なもの: [`.nvmrc`](.nvmrc) に記載の Node と pnpm 12。

```sh
git clone https://github.com/w01fb0ss/PiBot.git
cd PiBot
nvm use
pnpm install
pnpm dev        # start the desktop app in development
```

開発用のデータをインストール済みの Pi Bot と分けておくには、`PIBOT_DATA_DIR` を設定します。その他のコマンド:

| コマンド | 目的 |
|---|---|
| `pnpm check` | frozen install、型チェック、lint、ポリシーマトリクス、テスト |
| `pnpm check:changed [base]` | 変更された部分に限定した同じチェック |
| `pnpm verify` | `check`、ビルド、レンダラーのスモークテスト、エンドツーエンドの受け入れテストスイート |
| `pnpm build` | electron-vite ビルド (インストーラーなし) |

## リポジトリ構成

| パス | 内容 |
|---|---|
| `apps/desktop` | Electron アプリ (メインプロセス、レンダラー、パッケージング) |
| `apps/mobile` | Android アプリ (React Native + Expo) |
| `apps/relay` | スマートフォンとランナーの接続用リレー (Cloudflare Worker) |
| `apps/runner`, `apps/cli` | ヘッドレスランナーとコマンドラインのエントリーポイント |
| `apps/plugins` | 同梱プラグイン (MCP とスキルのいずれかまたは両方) |
| `packages/teams/builtin` | オフラインで使うために同梱されたロールとグループ。完全なロールライブラリは [pibot-roles](https://github.com/w01fb0ss/pibot-roles) にあります |
| `packages/*` | 頭脳とその機能 (5 つのレイヤー)。[AGENTS.md](AGENTS.md) を参照してください |
| `docs/guide`, `docs/privacy` | ユーザーガイドと外部接続に関する説明 |
| `tests`, `tools` | エンドツーエンドのテストスイート、フェイクモデル、開発ツール |

エージェントカーネルは [pi](https://github.com/earendil-works/pi) で、npm の依存関係としてバージョンを固定し、`packages/agent` でのみ使用しています。頭脳は Electron に依存しないため、同じコードがヘッドレスでも動作します。

## コントリビューション

Issue とプルリクエストを歓迎します。まず [CONTRIBUTING.md](CONTRIBUTING.md) と [AGENTS.md](AGENTS.md) のルールをお読みください。セキュリティの問題は公開の Issue ではなく、[SECURITY.md](SECURITY.md) に記載の方法で報告してください。

## Star 履歴

<a href="https://www.star-history.com/#w01fb0ss/PiBot&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=w01fb0ss/PiBot&type=Date" />
  </picture>
</a>

## ライセンス

[Apache License 2.0](LICENSE)。帰属表示については [NOTICE](NOTICE) と [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) を参照してください。
