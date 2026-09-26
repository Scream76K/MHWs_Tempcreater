# MHWilds Build Template Creator v0.2.7

## 修正内容
OCR処理本体が `window.lastEquipmentOCR = output` を実行した直後に、テンプレート側の `window.bridgeEquipment()` を直接呼び出す処理を追加。

これまでの setter 監視方式は残し、既存動作を壊さないようにした上で、OCR完了地点から確実に反映する二重経路にした。

## 静的確認
- v0.2.6と同じHTML/JS構造を維持
- v0.2.7の変更箇所はOCR完了直後のbridge呼び出し1箇所のみ
- HTMLパース確認：PASS
