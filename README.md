# 便利クリップメモ・そよぎ Web版 (iPad用PWA)

Chrome拡張「便利クリップメモ・そよぎ」のWeb版。GitHub Pagesでの公開用。
メモ・ピン止め・12色・編集・50件整理は拡張と同一。コピーの取り込みは
「いまのクリップボードを取り込む」ボタン(タップ時にiPadの貼り付け確認が出る)。
データは端末内(localStorage)のみ・外部送信なし。

## 構成
- `index.html` … PWA本体＋localStorageアダプタ(拡張のbackground.js相当)
- `store_logic.js` / `content.js` … 🔴拡張本体(copipe_fusen)と共用。直接編集禁止・`node _sync_web.js`で同期
- `sw.js` … cache-first。🔴更新のたびCACHE版数を上げる＋「開き直しで反映」を案内
- `manifest.webmanifest` / `icons/` … アイコンは透過なし正方形(`node _make_icons.js`)
- `node serve.js` → http://localhost:3133/ … 動作確認用

## GitHub Pages公開手順
1. このフォルダを公開リポジトリ(配布用)としてpush
2. Settings → Pages → Branch: main / root で有効化
3. 🔴反映されない時は「Pages押し病」= 一度無効化→再有効化で直る(脳活ジグソーで実績)

## iPad導入(マイさん向け説明はURL確定後に別途作成)
SafariでURLを開く → 共有ボタン → ホーム画面に追加
