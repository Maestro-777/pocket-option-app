# Тестирование и подтверждение

## Статус
Ветка реализации содержит новые unit-тесты, но тесты/сборка считаются пройденными только после успешного GitHub Actions run для актуального HEAD commit. Результаты более ранних commit не распространяются автоматически на последующие изменения.

## Автоматизированные тесты
- `node:test` покрывает timeframes, market data/tick aggregation, OHLC store, pattern normalization, matcher/look-ahead, example store, signal scheduler, decision journal, market-data bridge, trading gate, DEMO execution adapter и TradeLedger.
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
- [ ] Актуальный CI run для HEAD commit: `npm run check`, `npm test`, Windows x64 build.
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