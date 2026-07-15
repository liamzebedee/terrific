// Bun's bundler resolves image imports to a URL string at build time; declare
// the modules so `tsc --noEmit` accepts `import url from "./x.svg"`.
declare module "*.svg" {
  const url: string;
  export default url;
}
declare module "*.png" {
  const url: string;
  export default url;
}
