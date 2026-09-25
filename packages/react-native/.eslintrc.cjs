module.exports = {
  root: true,
  extends: ['@react-native', 'prettier'],
  plugins: ['prettier'],
  rules: {
    'react/react-in-jsx-scope': 'off',
    'prettier/prettier': [
      'error',
      {
        quoteProps: 'consistent',
        singleQuote: true,
        tabWidth: 2,
        trailingComma: 'es5',
        useTabs: false,
      },
    ],
  },
  ignorePatterns: [
    'node_modules/',
    'lib/',
    'src/generated/ddk_ffi.ts',
    'src/generated/ddk_ffi-ffi.ts',
    'src/generated/NativeDdkRn.ts',
    'src/generated/index.tsx',
    '../../examples/react-native/src/compatReplay.ts',
    '../../examples/react-native/src/compatVectors.ts',
  ],
};
