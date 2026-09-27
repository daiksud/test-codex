---
type: Guide
title: test-codex
description: "Issue #6 の Codex 自動処理 PoC の準備と検証手順。"
status: draft
sources:
  - id: issue6
    resource: https://github.com/daiksud/test-codex/issues/6
  - id: remote
    resource: https://learn.chatgpt.com/docs/remote-connections
  - id: cli-remote
    resource: https://github.com/openai/codex/blob/b412ff32c417f855c2b2d1581b77058eed87c84b/codex-rs/cli/src/main.rs
  - id: github-trigger
    resource: https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
  - id: github-queue
    resource: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idconcurrency
---

## test-codex

[Issue #6](https://github.com/daiksud/test-codex/issues/6) を仕様とする PoC。
`daiksud` が Issue を作成すると、Mac mini で Codex が調査と Plan 作成を行い、
ChatGPT アプリ内の承認後に同じ session で PR・merge・cleanup まで進めることを検証する。[^issue6]
**実機 E2E は未完了**。実装・ローカル検証の成功だけでは Issue #6 を完了にしない。

### 実機の準備

1. Mac mini に [repository self-hosted runner](https://github.com/daiksud/test-codex/settings/actions/runners/new) を登録し、
   `self-hosted` / `macOS` / `ARM64` のラベルでオンラインにする。同じ checkout はこの job が使う。
2. runner の実行ユーザーの `PATH` に Git、`gh`、Codex CLI を用意する。
   Git の commit identity を設定し、署名を使う場合は署名も対話なしで実行できる状態にする。
   検証した CLI は **0.156.1**。そのユーザーで `codex login` を行い、ChatGPT にログインする。
   Node 24 は workflow が用意する。API key や追加の PAT は使用しない。
3. **Mac mini 上で ChatGPT desktop app を起動**し、同じアカウント・workspace にログインして awake / online に保つ。
   mobile Remote は、その host app の Settings → Connections → Control this Mac/PC → Set up/Add で準備し、phone で QR を読む。
   接続・Plan 表示・承認を確認する。CLI の起動だけで設定済みとは扱わない。[^remote]
4. main の Ruleset で PR と `Codex verification` を必須にし、human approval は0、bypass actor は設定しない。
   必須 context は特定の GitHub App に固定しない。
   Actions の token で PR を作成できる repository 設定も必要。
   この repository には [Ruleset](https://github.com/daiksud/test-codex/rules/24056361) を設定済み。

runner は awake / online のまま保つ。秘密鍵・token を Issue やログに書かない。

### 処理と検証

[workflow](.github/workflows/codex-issue.yml) は `issues.opened` の author を確認し、
repository ごとの job concurrency と通常の clean `main` checkout を使う。
`queue: max` の platform 上限は pending 100件で、順序は concurrency 待機開始順。
上限に達した後の追加 job はキャンセルされる。Issue の作成順を保証するものではない。[^github-queue]

[controller](.github/scripts/codex-issue.mjs) は job 所有の stdio app-server を
`--remote-control` 付きで起動し、Remote の `connected` を待ってから Plan thread を作る。
この flag は検証した CLI の一時的な Remote 起動設定であり、sandbox や常駐 daemon の導入ではない。[^cli-remote]
Plan は read-only。MCP tools / apps / plugins はこの process で無効にする。
承認イベントを受けたらその read-only turn の終了を確認し、承認された Plan を Issue に投稿する。
投稿の証跡を得た後に workspace と `.git` への書き込み profile で同じ thread を続ける。

Git 操作、実装、チェック、セルフレビュー、PR、bot 対応、merge と checkout の cleanup は Codex が行う。
controller は Git を実行せず、Plan 投稿・session の継続と remote completion 条件の確認を担当する。
Codex の完了報告だけで成功にせず、Plan コメント、Issue、merged PR、required CI、
最新 head の bot review、remote main を API で照合する。
ローカル branch 削除・clean checkout はモデルの報告であり、実機の証跡で別途確認する。

`GITHUB_TOKEN` の push は push workflow を起動しない。[^github-trigger]
そのため Codex は毎回の正確な PR head で repository checks を実行し、Actions run URL 付きの
`Codex verification` commit status を pending → success に更新する。
人間の追加 workflow 承認は要求しない。`GH_TOKEN` は job の write token で、
`github-actions[bot]` としての書き込みはこの処理で意図したもの。

期限は **Issue 作成から24時間**で、queue 待機も含む。
一時障害は期限内で retry し、結果不明の投稿は先に remote 状態を確認する。
承認後の失敗では、時間と接続が残る場合だけ Codex の cleanup turn を試行し、元の失敗は保持する。
期限切れ・接続断では cleanup ができない場合があり、タイムアウト理由の投稿も best effort になる。

### ローカル確認

```sh
node --check .github/scripts/codex-issue.mjs
node --test tests/*.test.mjs
```

構文確認と Node の unit / contract / protocol integration tests が対象。
独立した build artifact / package build はない。
workflow の lint は actionlint / ShellCheck で確認する。
actionlint 1.7.12 は `queue: max` を知らないため、そのキーの診断だけを除外して確認した。

### 実機で残る確認

2026-09-27 のこの端末での CLI probe は起動と status API を受け付けたが、
20秒で `connecting` → `errored`、HTTP 409 の retry が7回あり、`connected` は観測できなかった。
原因は未確定。所有 process は終了済み。Remote の接続、ChatGPT の Plan 表示・承認、
UI が開始する turn の read-only 継承は実機での確認が必要。

API の模擬承認・loopback session 継続・ローカル Git fixture は、ChatGPT アプリの承認の証拠ではない。
Mac mini の job、author guard、実際の write token、直接 main push の拒否、CI・bot 修正と merge、
checkout cleanup、次 Issue の処理を実際の workflow で確認し、結果を Issue #6 に記録する。
workflow が main に入った後の新規 Issue が起点になる。既存 Issue #6 を再度開くだけでは
`issues.opened` の検証にならず、古い event は24時間期限により失敗する。

[^issue6]: PoC の要求と完了条件は Issue #6。
[^remote]: OpenAI の Remote connections の準備条件と mobile 設定手順。
[^github-queue]: GitHub Actions の job concurrency と queue の上限・待機順。
[^cli-remote]: 検証した Codex 0.156.1 の CLI source。`--remote-control` は `EnabledEphemeral` に対応する。
[^github-trigger]: GitHub の GITHUB_TOKEN による event と workflow 起動の規則。
