/** Adds `@source "<dir>"` to the app's stylesheet, so Tailwind scans a downstream build's folder (postcss.config.mjs). */
module.exports = ({ dir }) => ({
  postcssPlugin: "sail-extension-source",
  Once(root, { AtRule }) {
    if (root.source?.input.file?.endsWith("/src/app/globals.css")) root.append(new AtRule({ name: "source", params: JSON.stringify(dir) }));
  },
});
module.exports.postcss = true;
