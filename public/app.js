const addressInput = document.querySelector('#address');
const addressForm = document.querySelector('#address-form');
const frame = document.querySelector('#page-frame');
const homeScreen = document.querySelector('#home-screen');
const errorScreen = document.querySelector('#error-screen');
const recentList = document.querySelector('#recent-list');
const statusText = document.querySelector('#connection-status');
const statusDot = document.querySelector('#status-dot');
const pageLabel = document.querySelector('#page-label');
const backButton = document.querySelector('#back-button');
const forwardButton = document.querySelector('#forward-button');
const bookmarkButton = document.querySelector('#bookmark-button');

const historyKey = 'off-os-history';
const bookmarksKey = 'off-os-bookmarks';
let visits = readList(historyKey);
let bookmarks = readList(bookmarksKey);
let navigation = [];
let navigationIndex = -1;
let activeUrl = '';
let serviceWorkerReady = Promise.resolve();

function readList(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeAddress(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost\b|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/|$))/i.test(trimmed)) return `http://${trimmed}`;
  if (/^\S+\.\S+$/.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

function showView(view) {
  homeScreen.hidden = view !== 'home';
  frame.hidden = view !== 'page';
  errorScreen.hidden = view !== 'error';
}

function updateNavigation() {
  backButton.disabled = navigationIndex <= 0;
  forwardButton.disabled = navigationIndex >= navigation.length - 1;
  bookmarkButton.disabled = !activeUrl;
  bookmarkButton.textContent = bookmarks.some((item) => item.url === activeUrl) ? '★' : '☆';
  bookmarkButton.setAttribute('aria-label', bookmarks.some((item) => item.url === activeUrl) ? 'Remove bookmark' : 'Bookmark page');
}

function pageTitle(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function remember(url) {
  const entry = { url, title: pageTitle(url), visitedAt: Date.now() };
  visits = [entry, ...visits.filter((item) => item.url !== url)].slice(0, 24);
  localStorage.setItem(historyKey, JSON.stringify(visits));
  renderRecent();
}

function renderRecent() {
  const combined = [...bookmarks.map((item) => ({ ...item, pinned: true })), ...visits.filter((item) => !bookmarks.some((bookmark) => bookmark.url === item.url))].slice(0, 8);
  recentList.replaceChildren();
  if (combined.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-recent';
    empty.textContent = 'Your next page will show up here.';
    recentList.append(empty);
    return;
  }
  for (const item of combined) {
    const button = document.createElement('button');
    button.className = 'recent-item';
    button.type = 'button';
    const title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = item.title || pageTitle(item.url);
    const url = document.createElement('span');
    url.className = 'recent-url';
    url.textContent = item.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const arrow = document.createElement('span');
    arrow.className = 'recent-arrow';
    arrow.textContent = item.pinned ? '★' : '↗';
    button.append(title, url, arrow);
    button.addEventListener('click', () => openPage(item.url));
    recentList.append(button);
  }
}

function setConnectionStatus() {
  const online = navigator.onLine;
  statusText.textContent = online ? 'Online' : 'Offline';
  statusDot.classList.toggle('is-offline', !online);
}

async function openPage(value, { addHistory = true } = {}) {
  const url = normalizeAddress(value);
  if (!url) return;
  addressInput.value = url;
  activeUrl = url;
  pageLabel.textContent = 'FETCHING PAGE';
  updateNavigation();
  showView('error');
  document.querySelector('#error-message').textContent = 'Connecting to the local proxy…';
  try {
    await serviceWorkerReady;
    const response = await fetch(`/api/proxy?url=${encodeURIComponent(url)}`);
    if (!response.ok) throw new Error((await response.text()) || `Proxy returned ${response.status}.`);
    const html = await response.text();
    frame.srcdoc = html;
    showView('page');
    pageLabel.textContent = navigator.onLine ? 'PAGE LOADED' : 'SAVED PAGE · OFFLINE';
    if (addHistory) {
      navigation = navigation.slice(0, navigationIndex + 1);
      navigation.push(url);
      navigationIndex = navigation.length - 1;
    }
    remember(url);
    updateNavigation();
  } catch (error) {
    document.querySelector('#error-message').textContent = error.message || 'Check the address or reconnect and try again.';
    pageLabel.textContent = navigator.onLine ? 'CONNECTION ISSUE' : 'OFFLINE · NOT CACHED';
    showView('error');
  }
}

addressForm.addEventListener('submit', (event) => {
  event.preventDefault();
  openPage(addressInput.value);
});

document.querySelector('#home-button').addEventListener('click', () => {
  activeUrl = '';
  addressInput.value = '';
  pageLabel.textContent = 'READY WHEN YOU ARE';
  showView('home');
  updateNavigation();
});

backButton.addEventListener('click', () => {
  if (navigationIndex > 0) {
    navigationIndex -= 1;
    openPage(navigation[navigationIndex], { addHistory: false });
  }
});

forwardButton.addEventListener('click', () => {
  if (navigationIndex < navigation.length - 1) {
    navigationIndex += 1;
    openPage(navigation[navigationIndex], { addHistory: false });
  }
});

document.querySelector('#retry-button').addEventListener('click', () => openPage(addressInput.value, { addHistory: false }));

bookmarkButton.addEventListener('click', () => {
  const existing = bookmarks.some((item) => item.url === activeUrl);
  bookmarks = existing
    ? bookmarks.filter((item) => item.url !== activeUrl)
    : [{ url: activeUrl, title: pageTitle(activeUrl) }, ...bookmarks].slice(0, 24);
  localStorage.setItem(bookmarksKey, JSON.stringify(bookmarks));
  renderRecent();
  updateNavigation();
});

document.querySelector('#clear-history').addEventListener('click', () => {
  visits = [];
  localStorage.setItem(historyKey, '[]');
  renderRecent();
});

window.addEventListener('online', setConnectionStatus);
window.addEventListener('offline', setConnectionStatus);
setConnectionStatus();
renderRecent();

if ('serviceWorker' in navigator) {
  serviceWorkerReady = navigator.serviceWorker.register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then(async () => {
      if (!navigator.serviceWorker.controller) {
        await Promise.race([
          new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true })),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      }
    })
    .catch(() => {
      pageLabel.textContent = 'OFFLINE STORAGE UNAVAILABLE';
    });
}