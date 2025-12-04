const { override, useBabelRc, addWebpackResolve } = require('customize-cra');
const webpack = require('webpack');

module.exports = override(
  useBabelRc(),
  addWebpackResolve({
    fallback: {
      buffer: require.resolve('buffer'),
      path: require.resolve('path-browserify'),
      os: require.resolve('os-browserify/browser'),
      crypto: require.resolve('crypto-browserify'),
      stream: require.resolve('stream-browserify'),
      process: require.resolve('process/browser')
    }
  }),
  (config) => {
    config.plugins.push(
      new webpack.ProvidePlugin({
        process: 'process/browser',
      })
    );
    return config;
  }
);
