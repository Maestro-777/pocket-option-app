# Тестирование и подтверждение

## Текущий срез рабочей ветки
Работа находится в draft PR: https://github.com/Maestro-777/pocket-option-app/pull/2

### Автоматизированные проверки
- В репозитории добавлены node:test suites для свечного агрегатора, pattern engine, example store, market data parser, WebSocket bridge, trading gate, decision journal и snapshot store.
- CI workflow дополнен шагом `npm test` перед Windows installer build.
- Текущий GitHub Actions run для последнего commit необходимо дождаться; до conclusion нельзя указывать тесты/сборку как прошедшие.
- Локально в изолированном тестовом каталоге ранее прошли 20 тестов для первоначальной версии модулей. Это не заменяет запуск актуального набора тестов из ветки.

### Проверено чтением исходников
- [x] Основной README и package.json.
- [x] Electron main/preload/site-preload/site-bridge и renderer.
- [x] modules/manager.js.
- [x] pocket-tracker 3.6.0_0 inject.js и ARCHITECTURE.md: обработчики WebSocket, updateAssets/updateStream, история и текущий DOM execution flow.

### Не подтверждено runtime
- [ ] CDP debugger attach и injection на реальной странице Pocket Option.
- [ ] Реальное получение updateAssets/updateStream в Electron.
- [ ] Одновременные тики нескольких OTC-пар.
- [ ] Получение/разбор исторических OHLC событий для всех десяти таймфреймов.
- [ ] Сохранение/восстановление большого snapshot на Windows.
- [ ] UI разметки на длинных историях и разных разрешениях.
- [ ] npm start и полный smoke test Windows x64.
- [ ] DEMO торговля — торговый исполнитель ещё не реализован.
- [ ] REAL торговля — не реализована и не запускалась.

## Протокол проверок
Для каждого изменения фиксировать среду, точную команду/сценарий, результат и непроверенные пункты. Не считать тест пройденным только по наличию тестового файла.
