'use strict';

const { ipcRenderer } = require('electron');

if (window.top === window && !window.__PT_PO_PRELOAD_BRIDGE_INSTALLED__) {
  window.__PT_PO_PRELOAD_BRIDGE_INSTALLED__ = true;

  const visible = element => {
    if (!element || typeof element.getBoundingClientRect !== 'function') return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
      style.visibility !== 'hidden' && Number(style.opacity || 1) > 0.01;
  };

  const hidden = element => {
    if (!element) return true;
    const style = getComputedStyle(element);
    return element.getAttribute('data-hd-show') === '0' ||
      style.display === 'none' || style.visibility === 'hidden';
  };

  const parseBalance = element => {
    if (!element) return null;
    const raw = (element.getAttribute('data-hd-value') ||
      element.getAttribute('data-balance') || element.textContent || '')
      .replace(/\s/g, '').replace(/[^0-9,.-]/g, '');
    if (!raw) return null;
    let value = raw;
    if (value.includes(',') && value.includes('.')) {
      value = value.lastIndexOf(',') > value.lastIndexOf('.')
        ? value.replace(/\./g, '').replace(',', '.') : value.replace(/,/g, '');
    } else if (value.includes(',')) value = value.replace(',', '.');
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };

  const bestVisibleBalance = selectors => {
    const values = [];
    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach(element => {
        if (hidden(element) || !visible(element)) return;
        const value = parseBalance(element);
        if (value != null) values.push({ value, top: element.getBoundingClientRect().top, element });
      });
    }
    values.sort((a, b) => a.top - b.top);
    return values[0] || null;
  };

  const readActiveAccount = () => {
    const headers = [
      '.balance-info__button', '.balance-info__wrap', '.header-balance__current',
      '.header-balance__value-wrap', '.balance-current', '.js-current-account',
      '.balance-info:not(.balance-info--dropdown)', '.header__balance',
      '.top-header .balance-info'
    ];
    for (const selector of headers) {
      const root = document.querySelector(selector);
      if (!visible(root)) continue;
      const real = root.querySelector('.js-balance-real-USD,.js-hd.js-balance-real-USD,.js-balance-real');
      const demo = root.querySelector('.js-balance-demo,.js-hd.js-balance-demo');
      if (real && !hidden(real) && parseBalance(real) != null) return { accountType: 'real', balance: parseBalance(real) };
      if (demo && !hidden(demo) && parseBalance(demo) != null) return { accountType: 'demo', balance: parseBalance(demo) };
    }

    const demo = bestVisibleBalance([
      '.js-balance-demo', '.js-hd.js-balance-demo',
      '[class*="js-balance-demo"]', '[class*="balance-demo"]'
    ]);
    const real = bestVisibleBalance([
      '.js-balance-real-USD', '.js-hd.js-balance-real-USD', '.js-balance-real',
      '[class*="js-balance-real"]', '[class*="balance-real"]'
    ]);
    const demoActive = document.querySelector(
      '.accounts-list__item--demo.active,.accounts-list__item--demo.is-active,' +
      '.accounts-list__item--demo.selected,.balance-type-demo.active,' +
      '[data-account-type="demo"].active,.switcher__btn--demo.active,' +
      '.header-balance__item--demo.active,.js-switch-to-demo.active'
    );
    const realActive = document.querySelector(
      '.accounts-list__item--real.active,.accounts-list__item--real.is-active,' +
      '.accounts-list__item--real.selected,[data-account-type="real"].active,' +
      '.switcher__btn--real.active,.header-balance__item--real.active'
    );
    if (realActive && !demoActive && real) return { accountType: 'real', balance: real.value };
    if (demoActive && !realActive && demo) return { accountType: 'demo', balance: demo.value };

    const top = bestVisibleBalance([
      '.js-balance-demo', '.js-hd.js-balance-demo', '.js-balance-real-USD',
      '.js-hd.js-balance-real-USD', '.js-balance-real'
    ]);
    if (top) {
      const className = String(top.element.className || '');
      if (/real/i.test(className)) return { accountType: 'real', balance: top.value };
      if (/demo/i.test(className)) return { accountType: 'demo', balance: top.value };
    }
    return null;
  };

  let lastKey = '';
  let lastSentAt = 0;
  const publishBalance = () => {
    const account = readActiveAccount();
    if (!account || !['demo', 'real'].includes(account.accountType) ||
        !Number.isFinite(account.balance) || account.balance < 0) return;
    const state = {
      accountType: account.accountType,
      balance: account.balance,
      currency: '',
      ts: Date.now()
    };
    const key = JSON.stringify([state.accountType, state.balance]);
    if (key === lastKey && Date.now() - lastSentAt < 5000) return;
    lastKey = key;
    lastSentAt = Date.now();
    ipcRenderer.send('site:balance', state);
  };

  const startObserver = () => {
    if (!document.documentElement) return;
    const observer = new MutationObserver(publishBalance);
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: [
        'class', 'style', 'data-hd-show', 'data-hd-value',
        'data-balance', 'aria-selected', 'aria-current'
      ]
    });
    publishBalance();
  };

  startObserver();
  setInterval(publishBalance, 1000);
  window.addEventListener('pageshow', () => setTimeout(publishBalance, 250));
  window.addEventListener('popstate', () => setTimeout(publishBalance, 500));
}
