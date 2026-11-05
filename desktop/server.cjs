/**
 * Minimal static server for the built web app.
 *
 * Electron could open dist/index.html straight from disk, but Chromium refuses
 * to load an AudioWorklet module over file://, and the NAM wasm loader behaves
 * the same way. Serving over http://127.0.0.1 keeps the executable running the
 * exact same audio graph as the browser version, and gives IndexedDB a real
 * origin to store takes under.
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
}

/**
 * The desktop app serves itself, so it also sets the policy the browser would
 * normally get from a web host. Without it Electron prints a security warning on
 * every launch. Each allowance is one the app really uses: `wasm-unsafe-eval` for
 * the NAM model, `blob:` for AudioWorklet modules and decoded audio, and inline
 * styles because React writes them on the DOM.
 *
 * The `https:` in `script-src` and the `ws:`/`wss:` and `http:`/`https:` in
 * `connect-src` exist for one feature: the virtual cable. The DAW imports
 * `sala-sdk.js` from whatever machine is hosting the room (a LAN address typed by
 * the producer) and then carries Opus to the other musicians, so the policy has to
 * let a cross-origin module and a cross-origin socket through. Peer connections
 * themselves are not gated by CSP — there is no `webrtc` directive in the
 * specification, and Chromium 45 prints
 * "Unrecognized Content-Security-Policy directive 'webrtc'" for each load when one
 * is listed, so it is deliberately absent. `media-src` covers element sources; a
 * remote WebRTC stream arrives through `srcObject`, which is not a fetched URL and
 * is not affected by it.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob: http: https:",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "connect-src 'self' blob: data: http: https: ws: wss:",
  "img-src 'self' blob: data:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

/**
 * Serve `rootDir` on the loopback interface.
 *
 * `preferredPort` is asked for first and remembered by the app: the web session
 * stores takes in IndexedDB, which is keyed by origin, so a port that changes on
 * every launch would quietly wipe the user's recordings. If the port is taken by
 * something else the server still starts, on any free port.
 * Resolves with { url, port, close }.
 */
function serve(rootDir, preferredPort) {
  return new Promise((resolve, reject) => {
    const root = path.resolve(rootDir)
    const server = http.createServer((req, res) => {
      const requested = decodeURIComponent((req.url ?? '/').split('?')[0])
      const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '')
      const target = path.resolve(root, relative)
      // Anything that climbs out of dist/ is refused, whatever the URL says.
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403).end('forbidden')
        return
      }
      fs.readFile(target, (error, data) => {
        if (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
          return
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
          'content-security-policy': CSP,
        })
        res.end(data)
      })
    })

    const finish = (port) => {
      resolve({
        url: `http://127.0.0.1:${port}/`,
        port,
        close: () => new Promise((done) => { server.close(done) }),
      })
    }

    if (Number.isInteger(preferredPort) && preferredPort > 0) {
      server.once('listening', () => finish(preferredPort))
      server.once('error', (error) => {
        if (error.code !== 'EADDRINUSE') {
          reject(error)
          return
        }
        // Somebody else holds the remembered port: start anywhere free instead.
        server.removeAllListeners('listening')
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => {
          const address = server.address()
          finish(typeof address === 'object' && address ? address.port : 0)
        })
      })
      server.listen(preferredPort, '127.0.0.1')
      return
    }

    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      finish(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

module.exports = { serve }
