const fs = require('fs');
const path = require('path');
const pkg = require('../../packages/react-native/package.json');

module.exports = {
  // pnpm installs react-native as a symlink into node_modules/.pnpm, and
  // CocoaPods resolves every React pod's path through it with Ruby's
  // realdirpath, which intermittently corrupts the long symlink target on the
  // macOS runners ("pathname contains null byte", CocoaPods/CocoaPods#12798).
  // Handing autolinking the real directory keeps CocoaPods off the symlink,
  // the same fix Expo's autolinking applies (expo/expo#34203).
  reactNativePath: fs.realpathSync(
    path.dirname(require.resolve('react-native/package.json'))
  ),
  project: {
    ios: {
      automaticPodsInstallation: true,
    },
  },
  dependencies: {
    [pkg.name]: {
      root: path.join(__dirname, '../../packages/react-native'),
    },
  },
};
