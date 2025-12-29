import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const editorWritePlugin = (): Plugin => ({
  name: 'slopes-editor-write',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/__editor/saveTrack', async (req, res, next) => {
      if (req.method !== 'POST') return next()

      try {
        const chunks: Buffer[] = []
        await new Promise<void>((resolve, reject) => {
          req.on('data', (c) => chunks.push(Buffer.from(c)))
          req.on('end', () => resolve())
          req.on('error', reject)
        })
        const raw = Buffer.concat(chunks).toString('utf8')
        const body = JSON.parse(raw) as { track?: any }
        const track = body?.track
        if (!track || typeof track.id !== 'string') {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'Missing track' }))
          return
        }

        const outFile = path.resolve(process.cwd(), 'src/game/tracks.edited.ts')
        const prevText = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : ''
        const match = prevText.match(/EDITED_TRACK_SOURCES:\s*TrackSource\[\]\s*=\s*(\[[\s\S]*\])\s+as any/)
        let edited: any[] = []
        if (match?.[1]) {
          try {
            edited = JSON.parse(match[1])
          } catch {
            edited = []
          }
        }

        const idx = edited.findIndex((t) => t && t.id === track.id)
        if (idx >= 0) edited[idx] = track
        else edited.push(track)

        const next =
          `import type { TrackSource } from './track'\n\n` +
          `// This file is written by the in-game Track Editor when running under the Vite dev server.\n` +
          `// It is intended for local development workflow. Commit it if you want the authored edits to ship.\n` +
          `// The editor server endpoint rewrites the JSON below.\n` +
          `export const EDITED_TRACK_SOURCES: TrackSource[] = ${JSON.stringify(edited, null, 2)} as any\n`

        fs.writeFileSync(outFile, next, 'utf8')

        // Force the client to reload so the updated track module is picked up reliably.
        server.ws.send({ type: 'full-reload' })

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, count: edited.length }))
      } catch (err: any) {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
      }
    })
  },
})

export default defineConfig({
  plugins: [react(), editorWritePlugin()],
})


