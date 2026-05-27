import esbuild from 'esbuild'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const prod      = process.argv[2] === 'production'

esbuild.build({
  entryPoints: [join(__dirname, 'main.ts')],
  bundle:      true,
  // obsidian, electron, and all @codemirror/* packages are provided by
  // the host app at runtime — bundling them causes duplicate-instance crashes.
  external:    ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format:      'cjs',
  outfile:     join(__dirname, 'main.js'),
  platform:    'node',
  minify:      prod,
  sourcemap:   prod ? false : 'inline',
  target:      'es2018',
}).catch(() => process.exit(1))
