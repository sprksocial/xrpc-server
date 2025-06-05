/** @type {import('jest').Config} */
module.exports = {
  displayName: 'XRPC Server',
  transform: { '^.+\\.(j|t)s$': '@swc/jest' },
  transformIgnorePatterns: ['/node_modules/.pnpm/(?!(get-port)@)'],
  moduleNameMapper: { '^(\\.\\.?\\/.+)\\.js$': ['$1.ts', '$1.js'] },
}
