# Тестирование и подтверждение

**Актуальный срез:** 2026-11-20  
**Текущая ветка:** feature/market-data-adapter  
**Текущий Pull Request:** #6 (draft)

## Проверено чтением исходников

- [x] README, package.json, main.js и lifecycle приложения.
- [x] preload.js, site-preload.js, site-bridge.js.
- [x] renderer/app.js и renderer/index.html в части мониторинга.
- [x] core/timeframes.js, core/market-data.js, core/ipc-validation.js.
- [x] modules/manager.js и документы проекта.
- [x] pocket-tracker 3.6.0_0/manifest.json, ARCHITECTURE.md и релевантные участки inject.js.

## Локальные unit-тесты

- [x] Полный локальный прогон: 22 теста, 22 passed, 0 failed.
- [x] Проверка нормализации OTC, секундных/миллисекундных timestamp, тиков нескольких активов и дедупликации.
- [x] Проверка OHLC history с явными asset/period и отказ от приписывания истории активу DOM при отсутствии asset.
- [x] Проверка агрегации сохранённых тиков в S5 и независимости активов.
- [x] Проверка всех 10 согласованных таймфреймов и pre-entry окна без будущих/незавершённых свечей.
- [x] Проверка IPC: HTTPS Pocket Option host allow-list, expected webContents/frame URL, balance freshness/rate, market-batch allow-list/size.

## Windows CI

Последние подтверждённые полные результаты до извлечения последних IPC/timeframe additions:
- [x] Windows CI run #511: npm install, npm run check, 15/15 unit tests, NSIS x64 build.
- [x] Windows CI run #517: npm run check и npm test прошли после проверки свежести balance timestamp/account switch.
- [x] Windows CI run #526: syntax check и unit tests прошли после extraction IPC validators.

Текущий run #532:
- [x] npm install.
- [x] npm run check.
- [x] npm test — 22 теста завершились успешно.
- [x] npm run dist — Windows NSIS x64 installer и blockmap собраны успешно: dist/Pocket-Option-Background-Setup-0.1.1.exe.
- [x] Подтверждено: code signing пропущен, сертификат не настроен.

## Не проверено в реальном окружении

- [ ] Ручная установка и запуск собранного EXE на пользовательской Windows 11.
- [ ] Установка WebSocket tap до создания первого сокета сайта в реальной сессии.
- [ ] Получение реальных событий и бинарных кадров на актуальном Pocket Option.
- [ ] Одновременные тики по всем OTC-парам.
- [ ] Полнота истории неактивных пар.
- [ ] Задержка, пропуски, нагрузка и восстановление после reconnect.
- [ ] Electron integration test для фактического sender/webContents/frame.
- [ ] Persistence, migrations и backup/restore: движок хранения ещё не утверждён.
- [ ] DEMO end-to-end и любые REAL действия.

Нельзя считать live-поведение проверенным только потому, что исходный код или синтетические fixtures проходят unit-тесты.

## Ограничения и безопасность

- MarketDataStore хранит ограниченные буферы только в памяти; перезапуск удаляет накопленные данные.
- MAIN-world WebSocket-события остаются недоверенными данными и не являются командами.
- Balance bridge использует same-origin window.postMessage. Свежесть/rate validation не доказывает происхождение сообщения; same-origin script страницы может его подделать.
- Автоматические сделки не включены и не тестируются.
- Не запускать REAL сделки без отдельного согласования.

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
