# たべつな

子ども食堂と受取拠点のスタッフで、食品の在庫と予約を共有するアプリです。画面とAPIをCloudflare Workersで配信し、データをCloudflare D1に保存します。

[たべつな 運用版を開く](https://tabetsuna.kodomojyanaimon.workers.dev)

## デモ

[運用版と同じ画面のデモを開く](https://tabetsuna-demo.kodomojyanaimon.workers.dev)

子ども食堂は `hidamari`（須賀食品）または `aozora`（豆心フーズ）、スタッフは `staff` でログインします。共通の試作用パスワードはデモのログイン画面に表示します。デモ専用D1の在庫、予約、団体情報は利用者間で共有され、日本時間で日付が変わると次の画面更新時に初期化されます。共通IDは固定で、パスワード変更と新規IDの発行は運用版で行います。

デモを初めてセットアップする場合は、専用DBの名前と設定ファイルを指定して初期化します。

```sh
npx wrangler d1 migrations apply tabetsuna-demo --remote --config wrangler.demo.jsonc
npx wrangler d1 execute tabetsuna-demo --remote --config wrangler.demo.jsonc --file demo/initialize.sql
npx wrangler deploy --config wrangler.demo.jsonc
```

## ローカルで試す

```sh
npm ci
npm test
npm run db:local
npm run dev
```

別のターミナルで `npm run setup -- --local` を実行し、表示された初期設定リンクで管理者IDとパスワードを設定します。

## Cloudflareで運用する

1. `npx wrangler login` で、公開先のCloudflareアカウントを承認します。
2. `npm run deploy` でWorkerを作成します。設定は `wrangler.jsonc` の `DB` にD1データベース `tabetsuna` を割り当てます。
3. `npm run db:remote` でD1にテーブルを作成します。
4. `npm run setup -- --remote https://実際のWorkerのURL` で初期設定リンクを発行し、最初の管理者を登録します。リンクは30分有効で、管理者を登録すると使用済みになります。初期設定リンクは管理者本人が使ってください。

GitHubからの自動配信を設定する場合は、Cloudflare の **Workers & Pages → tabetsuna → Settings → Builds → Connect** で `furusapo/tabetsuna` を選びます。D1のマイグレーションは、変更を確認してから `npm run db:remote` で反映します。[WorkersのGitHub連携](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/github-integration/) · [D1のマイグレーション](https://developers.cloudflare.com/d1/reference/migrations/)

## 管理者・団体・スタッフ

- **管理者**は「団体一覧」で子ども食堂と拠点スタッフのIDを発行します。
- **子ども食堂と拠点スタッフ**は仮パスワードでログインし、初回にパスワードを変更します。
- **子ども食堂**は団体情報を登録すると、住所の都道府県に応じて栃木県は豆心フーズ（佐野）、埼玉県は須賀食品に割り当てられます。自団体の予約の確認とキャンセルができます。
- **拠点スタッフ**は担当拠点の在庫と予約を管理します。準備にチェックを入れてから、団体・日時ごとに引き渡しを完了します。

パスワードはscryptで照合用のハッシュを作成し、D1に保存します。アプリは同一オリジンのセッションCookieを使い、サーバーで操作権限を確認します。ブラウザ保存版で操作したサンプルデータは、運用開始時には別扱いです。

郵便番号の住所データは日本郵便の2026年10月30日更新分です。[日本郵便の住所データ](https://www.post.japanpost.jp/service/search/zipcode/download/utf-zip.html)
