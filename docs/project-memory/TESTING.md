# Тестирование и подтверждение

## Срез на 2026-11-19

### Проверено чтением исходников GitHub
- [x] README и package.json основного репозитория.
- [x] main.js (файл получен; отдельные IPC и lifecycle требуют полного прохода для соответствующих задач).
- [x] preload.js, site-preload.js, site-bridge.js.
- [x] renderer/app.js (получен; полный проход потребуется для UI-задач).
- [x] modules/manager.js и modules/README.md.
- [x] Developer Guide и User Guide.
- [x] pocket-tracker 3.6.0_0/manifest.json и ARCHITECTURE.md.

### Подтверждено чтением и unit-тестами
- [x] Структура приложения, разделение Electron/Chrome, узкий preload API, DOM-адаптер баланса и модульный менеджер.
- [x] По исходникам 3.6.0 установлено: бинарные Socket.IO payload декодируются как UTF-8 JSON; updateStream/quotes/stream несут тики, в том числе нескольких активов.
- [x] Локально на Node.js 22.16.0: `node --test` — 32 теста пройдены, 0 ошибок (временная локальная копия исходников).
- [x] Unit-тесты AssetCatalog, CandleSeries, MarketDataHub, Socket.IO decoder, CDP capture adapter и SQLite MarketDataStore.
- [x] Проверка перезапуска/восстановления SQLite, транзакционного upsert, диапазонных запросов, schema version, dirty revision acknowledgement и backpressure.
- [ ] Electron runtime smoke test (`npm run test:electron`) — ожидает результата Windows CI.
- [x] OTC-фильтр: проверка явного OTC, normal assets, неизвестных символов и неоднозначных alias.
- [x] Тесты покрывают таймфреймы, OHLC, поздние тики, ограничение памяти, pre-entry окно, изоляцию сокетов и обработку malformed frames.

### Не запускалось или не подтверждено
- [ ] npm install.
- [ ] npm run check локально.
- [ ] npm start.
- [ ] npm run pack / npm run dist.
- [ ] запуск на Windows 11 x64.
- [ ] интеграция с текущим Pocket Option.
- [ ] end-to-end рыночные данные на живом Pocket Option.
- [ ] Проверка CDP capture на Windows Electron 45.3.4.
- [ ] Проверка SQLite write latency и memory footprint на реальном потоке OTC.
- [ ] DEMO сделки.
- [ ] REAL сделки.

Нельзя считать пункт проверенным только потому, что он описан в документации или CI.

## Протокол будущих проверок
Для каждой задачи записывать среду, команду/сценарий, результат, проверенные ограничения и непроверенные пункты.

Минимум:
1. Синтаксическая проверка изменённых JS.
2. Unit tests алгоритмов и валидаторов.
3. Тесты схемы и миграций хранилища.
4. IPC tests для sender, типов и диапазонов payload.
5. Market Data tests на обезличенных fixtures.
6. Тесты отсутствия look-ahead leakage.
7. Пауза: анализ продолжает работать, новые сделки блокируются.
8. Идемпотентность сигналов и лимит одновременных сделок.
9. DEMO end-to-end до рассмотрения REAL.

Тесты реальной торговли не запускать без отдельного согласования.
