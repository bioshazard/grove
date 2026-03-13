import http from 'http';

// Simple SSR server that demonstrates hydration mismatch
const server = http.createServer((req, res) => {
  // Server-side rendered HTML
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>SSR Hydration Example</title>
  <style>
    .greeting { color: blue; }
    .timestamp { color: green; }
    .unused-class { color: red; } /* This class is never used */
  </style>
</head>
<body>
  <div id="app">
    <h1 class="greeting">Hello, World!</h1>
    <p class="timestamp" data-server-time="${Date.now()}">Server time</p>
  </div>
  <script>
    // Client-side hydration - INTENTIONAL MISMATCH
    // Server renders "Server time" but client will change it
    setTimeout(() => {
      const timestamp = document.querySelector('.timestamp');
      if (timestamp) {
        timestamp.textContent = 'Client time: ' + new Date().toLocaleTimeString();
        timestamp.setAttribute('data-client-time', '${Date.now()}');
      }
    }, 100);
  </script>
</body>
</html>
  `;

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(html);
});

const PORT = 3456;
server.listen(PORT, () => {
  console.log(`SSR Example server running at http://localhost:${PORT}`);
});
