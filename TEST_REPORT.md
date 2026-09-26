# MHWilds Build Template Creator v0.2.6 test report

## 修正
- v0.2.5でOCR結果が認識されてもテンプレート入力欄へ自動反映されず、別途「OCR結果をテンプレートへ反映」を押す必要があった問題を修正。
- `window.lastEquipmentOCR` の更新を監視し、OCRエンジンが7部位の結果を書き込んだ時点で `bridgeEquipment()` を自動実行。
- Shadow DOM内のOCRエンジンからLight DOM側のテンプレート反映処理を呼べるよう `window.bridgeEquipment` を公開。
- OCRを再実行した場合、既存の装飾品入力を一度クリアしてから最新結果を反映し、二重登録を防止。
- 手動の「OCR結果をテンプレートへ反映」ボタンは残している。

## 検証
- HTML内の3個のinline JavaScriptブロックをNode.js `--check`で構文確認：OK
- ZIP `unzip -t`：OK
