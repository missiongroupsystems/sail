# Patches

`pnpm` applies these to the installed packages (`pnpm.patchedDependencies` in the root `package.json`).

## `next@15.5.29.patch`

- **Google font loader** (`dist/compiled/@next/font/dist/google/loader.js`): Google can answer with extensionless
  `/l/font?kit=…` URLs; the loader takes WOFF2 for those, as Next.js 16 does.
- **React's `useId` during hydration** (`dist/compiled/react-dom*/cjs/react-dom-*.js`): the React that Next 15.5
  bundles (19.2.0 canary) clears a fiber's `Forked` flag when it resets the fiber to replay it after a suspension. A
  lazy element from the streamed server payload that suspends while hydrating and is replayed then loses its place in
  the `useId` tree, so every id under it differs from the server HTML ("A tree hydrated but some attributes of the
  server rendered HTML didn't match", react-aria ids). React fixed this by adding `Forked` to `StaticMask`
  (`packages/react-reconciler/src/ReactFiberFlags.js`; react-dom 19.3 has it). The patch makes the same change to the
  inlined mask: `StaticMask` `65011712` → `66060288` and `StaticMask | Placement` `65011714` → `66060290` (`Forked` is
  `1048576` in this build). Drop it when Next bundles a React with the fix.
