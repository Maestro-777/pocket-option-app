# Тестирование и подтверждение

## Статус
Автоматическая проверка кода на commit `9f9e6fafcc0b8559bd14c2c76d059bae006183bb` в ветке `work/pattern-engine-foundation` завершилась успешно. После этого commit были проверены совпадающие SHA основных runtime-файлов (main.js, market-data-bridge.js, trade-execution.js, trade-ledger.js, signal-scheduler.js, package.json). Документационные обновления не меняют исполняемый код.

## Автоматизированные тесты
- `node:test` покрывает timeframes, market data/tick aggregation, CDP multi-socket capture, OTC AssetCatalog, Socket.IO text/binary decoder, OHLC store, pattern normalization, matcher/look-ahead, example store, signal scheduler, decision journal, page bridge, trading gate, DEMO execution adapter, scan-state recovery и TradeLedger.
- Отдельные проверки покрывают запрет REAL, явное включение DEMO, сериализацию команд, отмену in-flight команды при паузе, сверку после перезапуска, fail-closed DOM asset mismatch и отказ от неоднозначной корреляции.
- `npm run check` проверяет синтаксис main/preload/site bridge/market-data bridge/core и renderer annotation.
- `npm test` запускает unit-тесты.
- `npm run dist` должен собрать Windows x64 installer в CI.

## Проверено чтением исходников
- [x] Основной README/package.json и архитектура Electron.
- [x] main/preload/site-preload/site-bridge/renderer.
- [x] pocket-tracker 3.6.0 inject.js и ARCHITECTURE.md: WebSocket, updateAssets/updateStream, history, DOM selectors и executeTrade flow.
- [x] Новые core модули и тестовые сценарии проверены чтением исходников.
- [x] ScanStateStore и восстановление dedup баров добавлены в unit tests.

## Не подтверждено runtime
- [x] GitHub Actions run `44607178193` для commit `9f9e6fafcc0b8559bd14c2c76d059bae006183bb`: `npm run check` успешно, `npm test` — 65 passed / 0 failed, Windows installer build — успешно.
- [ ] CDP attach/injection на живой странице Pocket Option.
- [ ] Реальный одновременный updateStream нескольких OTC-пар.
- [ ] Исторические свечи по всем десяти таймфреймам и нескольким парам.
- [ ] Отдельное окно разметки на Windows и длинных диапазонах.
- [ ] Реальное переключение OTC пары через changeSymbol и DOM подтверждение.
- [ ] Сумма, экспирация и правильная UP/DOWN кнопка на текущем сайте.
- [ ] Фактическое открытие DEMO ордера и close-event payload.
- [ ] Однозначная корреляция закрытия нескольких сделок по разным парам.
- [ ] Полный Windows x64 smoke test и soak test.

## Протокол
Для каждого изменения фиксировать актуальный commit, workflow run, среду, команду/сценарий, результат и непроверенные пункты. Не считать тест пройденным только по наличию тестового файла или по результату предыдущего commit.

## Последний автоматический прогон
- Branch: `work/pattern-engine-foundation`
- Commit: `9f9e6fafcc0b8559bd14c2c76d059bae006183bb`
- Workflow run: `44607178193` — success
- Unit tests: 65/65 passed
- JavaScript syntax: passed
- Windows installer build: passed
- Live Pocket Option DEMO smoke test: не проводился; это остаётся обязательным runtime этапом.
