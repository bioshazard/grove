"""
Simple HTTP server for testing CDP functionality
Demonstrates SSR content with potential hydration mismatch
"""
import http.server
import socketserver
import time

class SSRHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Server-side rendered HTML
        html = f'''
<!DOCTYPE html>
<html>
<head>
    <title>Python SSR Example</title>
    <style>
        .header {{ color: blue; }}
        .footer {{ color: gray; }}
        .dead-css {{ background: red; }} /* Never used - for dead CSS detection */
    </style>
</head>
<body>
    <div id="app">
        <h1 class="header">Hello from Python Server!</h1>
        <p class="footer" data-server-ts="{int(time.time() * 1000)}">Server rendered</p>
    </div>
    <script>
        // Client-side modification - creates hydration mismatch
        setTimeout(() => {{
            const footer = document.querySelector('.footer');
            if (footer) {{
                footer.textContent = 'Client modified at: ' + new Date().toLocaleTimeString();
                footer.setAttribute('data-client-ts', '{int(time.time() * 1000)}');
            }}
        }}, 100);
    </script>
</body>
</html>
'''
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(html.encode())

PORT = 3457
with socketserver.TCPServer(("", PORT), SSRHandler) as httpd:
    print(f"Python SSR server running at http://localhost:{PORT}")
    httpd.serve_forever()
