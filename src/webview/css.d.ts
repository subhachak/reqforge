// esbuild bundles the stylesheet as a side-effect import; TypeScript only needs
// to know the module exists.
declare module '*.css';
