// DRAMAcube 대시보드 푸시 알림용 서비스워커
self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: '알림', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'DRAMAcube 알림';
  const options = {
    body: data.body || '',
    icon: 'https://fonts.gstatic.com/s/i/short-term/release/googlesymbols/notifications/default/24px.svg',
    data: { url: data.url || '/' },
    tag: 'dramacube-actor-news'
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(clients.openWindow(url));
});
