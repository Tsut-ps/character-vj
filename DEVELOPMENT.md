# 開発ガイド

この文書では開発環境、観客スマホリモートの構成、Cloudflare設定、デプロイ、検証方法を説明します

## ローカル開発

### フロントエンドだけを起動する

```bash
npm install
npm run dev
```

`http://localhost:5173/character-vj-vite/` を開きます

### リモート機能を含めて起動する

初回だけフロントエンドとWorkerの依存関係を導入します

```bash
npm install
cd remote-worker
npm install
```

1つ目のターミナルでWorkerを起動します

```bash
cd remote-worker
npm run dev
```

プロジェクト直下へ `.env.local` を作成します。`.env.example` からコピーできます

```text
VITE_REMOTE_BASE_URL=http://localhost:8787
```

2つ目のターミナルでフロントエンドを起動します

```bash
npm run dev
```

実機スマートフォンからローカル環境へ接続する場合は、HTTPSで到達できるオリジンを用意し、その完全なオリジンをWorkerの `ALLOWED_ORIGINS` へ追加してください

## リモート機能の構成

```text
観客スマートフォン
  → RemoteCommandと連番
  → AUTO: WebSocketからWebRTCへ切り替え、失敗時はWebSocketを継続
  → DIRECT / TURN: 順序保証付きDataChannel
  → WS RELAY: PartySocket → Room PartyServer → ホスト
  → RemoteInputAdapter
  → AppAction
  → VJApp / CueEngine

WebRTCシグナリング
  → rtcOffer / rtcAnswer / rtcIceCandidate
  → 認証済みPartySocket
  → Room PartyServer
```

Cloudflare側はキューやBPMを処理せず、WebSocket経由のコマンドとWebRTCシグナリングを認証済み接続間で転送します

WebSocketは全接続方式で認証、参加状態、権限、コントローラー一覧、シグナリング、フォールバックに使う制御経路として維持されます

コントローラー同士は接続せず、ホストと各コントローラーの間に1本ずつPeerConnectionを作ります。どの通信経路でも `RemoteInputAdapter` 以降は同じ処理です

### 接続方式

- `AUTO`: WebSocketを利用しながらWebRTCを確立し、DataChannelが開いた時点で切り替え。ICEは直接経路またはTURNを選択
- `DIRECT`: STUNのみを使うWebRTC直接接続。接続失敗時の自動フォールバックなし
- `TURN`: Cloudflare Realtime TURNと `iceTransportPolicy: "relay"` を使うWebRTC接続
- `WS RELAY`: コントローラー、Durable Object、ホストを結ぶWebSocket接続

画面には利用中の通信方式、ICE経路、RTT、片道遅延の概算値を表示します。WebRTCのRTTはDataChannel、WebSocketのRTTはRoomのping/pongで計測します

## 主なコード

- `src/controller/`: 観客スマートフォン用画面と接続処理
- `src/app/remote/`: ホスト側のセッション、入力変換、WebSocket、WebRTC処理
- `remote-worker/`: Cloudflare Worker、Durable Object、認証、転送処理
- `tests/`: フロントエンド側の自動テスト
- `remote-worker/tests/`: Worker側の自動テスト

## セキュリティ設計

- ネットワークから `AppAction` を直接受け取らず、版番号付きの `RemoteCommand` をZodで実行時検証
- 通常のクライアントメッセージは1 KiBまでに制限し、不正JSON、未知の版、未知のコマンド、範囲外のキューを拒否
- SDPを含むWebRTCシグナリングだけ個別の上限を設定
- DataChannelでも上限とZod検証を通過した `RemoteEnvelope` だけを受理
- ホストだけがオファーを送信し、アンサーとICE候補はサーバーが確定した `controllerSessionId` と紐付け
- 接続相手ごとの未処理ICE候補を64件までに制限
- 識別情報、役割、権限、コントローラー識別子は認証済みWebSocketセッションからサーバー側で決定
- ホストトークン、QR用の参加シークレット、短期セッションチケットを分離し、ホストトークンをQRへ含めない
- セッションチケットはURLへ含めず、WebSocket接続時のサブプロトコルだけで送信
- 参加シークレットはURLフラグメントへ入れ、読み取り後すぐアドレスバーから除去
- 参加シークレットとチケットはWeb Cryptoで生成し、Durable ObjectにはSHA-256ハッシュだけを保存
- `CLOSE JOIN` の応答前に参加受付を閉じてシークレットを無効化し、再度開く時は必ずシークレットを更新
- コントローラーごとの単調増加連番をWorkerとホストの両方で検証
- コントローラー切断時は押下中のキューをホスト側で解放
- Workerとホストでコントローラーごとの入力頻度を制限し、既知のキュー解放は優先
- ルーム全体は毎秒600メッセージ、接続中コントローラーは100台、未期限切れセッションは200件までに制限
- 未接続チケットと初回接続待ちは1分で失効し、接続後だけルーム期限まで延長
- ホスト操作、ルーム作成、チケット発行、参加、WebSocket接続にも頻度制限を適用
- PartySocketは送信待ち行列を無効化し、切断中の操作を再接続後に送らない
- ホストトークンはリモートセッション中のメモリーだけに保持し、ブラウザーの保存領域へ残さない
- ルームとWebSocketセッションは作成から最大1時間で削除
- 本番CORSとWebSocketのオリジンは `ALLOWED_ORIGINS` との完全一致だけを許可

※ルーム作成APIは公開フロントエンドから使用するため、オリジン制限と頻度制限だけではホスト本人の認証になりません。自動作成への追加防御が必要な場合はCloudflare TurnstileまたはAccessを導入

WebRTCでは接続相手へICE候補のネットワーク情報が共有されます。直接接続を避ける必要がある場合は `TURN` または `WS RELAY` を使用

## Cloudflare設定

### Workerの基本設定

1. CloudflareアカウントでWorkersを利用可能にする
2. `npx wrangler login` でデプロイ先アカウントを選択する
3. `remote-worker/wrangler.jsonc` の `ALLOWED_ORIGINS` を公開するGitHub Pagesのオリジンへ設定する
4. `ratelimits` の `namespace_id` が同じアカウント内の別バインディングと重複していないことを確認する

`ALLOWED_ORIGINS` にはパスを含めず、`https://example.github.io` のような完全なオリジンを指定します。本番値へlocalhostや `*` を追加しないでください

Durable Objectのバインディング、SQLiteのマイグレーション、Rate Limitingのバインディングは `remote-worker/wrangler.jsonc` で宣言しています

### Cloudflare Realtime TURN

Cloudflare RealtimeでTURNキーを作成し、長期認証情報をWorkerのシークレットとして登録します

```bash
cd remote-worker
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

ローカル開発では `.dev.vars.example` を `.dev.vars` へコピーして値を設定します。`.dev.vars` はコミットしないでください

Workerは長期TURNキーを短期ICE認証情報へ交換します。TURNのシークレットを `VITE_*`、GitHub Pages、QR URL、ブラウザー用バンドルへ含めないでください

### GitHub Pagesの環境変数

リポジトリの `Settings` → `Secrets and variables` → `Actions` → `Variables` へ次の公開Worker URLを登録します

```text
VITE_REMOTE_BASE_URL=https://character-vj-remote.<YOUR_SUBDOMAIN>.workers.dev
```

公開URLなのでシークレットではなくActionsの変数として登録します。末尾へパスを付けないでください。GitHub側にTURNのシークレットを登録する必要はありません

## デプロイ

Workerを検証してデプロイします

```bash
cd remote-worker
npm run typecheck
npm test
npx wrangler deploy --dry-run
npm run deploy
```

初回デプロイ時にSQLiteを使用するDurable Objectのマイグレーションが適用されます

デプロイ後の `workers.dev` URLを `VITE_REMOTE_BASE_URL` へ設定し、GitHub Pagesを再構築します

## 検証

### 自動検証

フロントエンド側を検証します

```bash
npm run build
npm run typecheck:test
npm test
```

Worker側を検証します

```bash
cd remote-worker
npm run typecheck
npm test
```

### 実機確認

1. GitHub PagesのVJ画面でキーボード、ゲームパッド、MIDI、素材割り当て、効果音を確認
2. `REMOTE` → `START REMOTE` でホストがオンラインになることを確認
3. `SHOW QR` で参加受付完了後にQRが表示されることを確認
4. 2台以上のスマートフォンで参加し、台数と個別RTTが表示されることを確認
5. キュー1〜9のタップと長押しが動作することを確認
6. `CLOSE JOIN` 後は古いQRから新規参加できず、接続済みコントローラーは操作を継続できることを確認
7. 権限変更がコントローラー画面とサーバー側の拒否へ反映されることを確認
8. キュー長押し中に通信を切るかページを離れ、ホスト側で押下状態が解放されることを確認
9. ホストの一時切断後に再接続し、コントローラー切断時はQRの再読み取り案内になることを確認
10. WorkerのログにOrigin拒否、頻度制限、予期しない例外がないことを確認
11. `WS RELAY` でキュー、長押し、権限、QR終了、切断時の解放を確認
12. `DIRECT` でWebRTC接続と経路表示を確認
13. `TURN` でWebRTC接続とTURN経路表示を確認
14. `AUTO` でWebSocketからWebRTCへ切り替わることを確認
15. WebRTCへ接続できない場合も `AUTO` がWebSocketで操作を継続することを確認

ルームの有効期間、権限、頻度制限、複数コントローラー、QR終了時の挙動は全接続方式で共通です
