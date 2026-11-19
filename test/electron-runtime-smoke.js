'use strict';

const { app } = require('electron');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  let database;
  try {
    const { DatabaseSync } = require('node:sqlite');
    database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE smoke_test (value INTEGER NOT NULL) STRICT');
    database.prepare('INSERT INTO smoke_test(value) VALUES (?)').run(42);
    const row = database.prepare('SELECT value FROM smoke_test').get();
    if (row?.value !== 42) throw new Error('SQLite round-trip returned an unexpected value');
    database.close();
    console.log('Electron runtime SQLite smoke test passed');
    app.exit(0);
  } catch (error) {
    try { database?.close(); } catch (_) {}
    console.error('Electron runtime SQLite smoke test failed:', error);
    app.exit(1);
  }
}).catch(error => {
  console.error('Electron startup failed:', error);
  app.exit(1);
});
