import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const browserExternals = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
]

const cssPrefix = '\0dsh-codex-css:'
const cssSuffix = '.mjs'

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      invariant: 'src/invariant.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
  },
  {
    entry: {
      client: 'src/client/index.ts',
    },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    external: browserExternals,
    noExternal: id => browserExternals.includes(id) ? undefined : true,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-codex", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    plugins: [{
      name: 'dsh-codex-css',
      resolveId(source, importer) {
        if (!source.endsWith('.module.css') || importer === undefined) return null
        return `${cssPrefix}${resolve(dirname(importer), source)}${cssSuffix}`
      },
      async load(id) {
        if (!id.startsWith(cssPrefix)) return null
        const file = id.slice(cssPrefix.length, -cssSuffix.length)
        const { code, exports } = transform({
          filename: file,
          code: await readFile(file),
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classes = Object.fromEntries(Object.entries(exports ?? {}).map(([name, value]) => [name, value.name]))
        const tagId = `dsh-codex/${basename(file)}`
        return [
          `const css = ${JSON.stringify(code.toString())};`,
          `const tagId = ${JSON.stringify(tagId)};`,
          'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
          '  const tag = document.createElement("style");',
          '  tag.dataset.plugin = "dsh-codex";',
          '  tag.dataset.pluginCss = tagId;',
          '  tag.textContent = css;',
          '  document.head.appendChild(tag);',
          '}',
          `export default ${JSON.stringify(classes)};`,
        ].join('\n')
      },
    }],
  },
])
