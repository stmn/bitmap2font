# serwer dev bez cache - przegladarka zawsze dostaje swieze pliki
import http.server, functools

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

http.server.test(functools.partial(NoCache, directory='dist'), port=8741)
